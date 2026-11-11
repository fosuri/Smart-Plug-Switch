/**
 * Minimal local-network client for TP-Link Tapo plugs (P100/P110/...) using the KLAP protocol.
 *
 * Same protocol python-kasa uses ("KlapTransportV2"), implemented with Node's built-in crypto:
 *  1. POST /app/handshake1 with 16 random bytes  -> device returns its seed + proof it knows our credentials
 *  2. POST /app/handshake2 with our proof         -> device accepts the session (cookie)
 *  3. POST /app/request?seq=N with AES-128-CBC encrypted JSON commands
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";

export class TapoAuthError extends Error {}

export type DeviceInfo = {
	device_on: boolean;
	/** Seconds since the plug was switched on (only meaningful while on). */
	on_time?: number;
	model?: string;
	nickname?: string;
	[key: string]: unknown;
};

const sha1 = (b: Buffer): Buffer => createHash("sha1").update(b).digest();
const sha256 = (...parts: Buffer[]): Buffer => {
	const h = createHash("sha256");
	for (const p of parts) h.update(p);
	return h.digest();
};
const md5 = (b: Buffer): Buffer => createHash("md5").update(b).digest();

class KlapSession {
	private seq: number;

	constructor(
		readonly cookie: string,
		readonly expiresAt: number,
		private readonly key: Buffer,
		private readonly ivPrefix: Buffer,
		private readonly sig: Buffer,
		seq: number,
	) {
		this.seq = seq;
	}

	encrypt(plain: Buffer): { seq: number; payload: Buffer } {
		this.seq = this.seq >= 0x7fffffff ? -0x80000000 : this.seq + 1;
		const seqBuf = Buffer.alloc(4);
		seqBuf.writeInt32BE(this.seq);
		const cipher = createCipheriv("aes-128-cbc", this.key, Buffer.concat([this.ivPrefix, seqBuf]));
		const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
		const signature = sha256(this.sig, seqBuf, encrypted);
		return { seq: this.seq, payload: Buffer.concat([signature, encrypted]) };
	}

	decrypt(seq: number, payload: Buffer): Buffer {
		const seqBuf = Buffer.alloc(4);
		seqBuf.writeInt32BE(seq);
		const decipher = createDecipheriv("aes-128-cbc", this.key, Buffer.concat([this.ivPrefix, seqBuf]));
		return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
	}
}

export class TapoClient {
	private session: KlapSession | undefined;
	private readonly authHashV2: Buffer;
	private readonly authHashV1: Buffer;
	private readonly terminalUuid = Buffer.from(md5(Buffer.from(randomUUID()))).toString("base64");

	constructor(
		readonly host: string,
		username: string,
		password: string,
		private readonly timeoutMs = 5000,
	) {
		const u = Buffer.from(username, "utf8");
		const p = Buffer.from(password, "utf8");
		this.authHashV2 = sha256(sha1(u), sha1(p));
		this.authHashV1 = md5(Buffer.concat([md5(u), md5(p)]));
	}

	async getDeviceInfo(): Promise<DeviceInfo> {
		return (await this.request("get_device_info")) as DeviceInfo;
	}

	async setOn(on: boolean): Promise<void> {
		await this.request("set_device_info", { device_on: on });
	}

	/** Drops the current session so the next request performs a fresh handshake. */
	reset(): void {
		this.session = undefined;
	}

	private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
		try {
			return await this.send(method, params);
		} catch (err) {
			if (err instanceof TapoAuthError) throw err;
			// Session may have expired or the device rebooted: retry once with a fresh handshake.
			this.session = undefined;
			return await this.send(method, params);
		}
	}

	private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		const session = await this.getSession();
		const body: Record<string, unknown> = {
			method,
			request_time_milis: Date.now(),
			terminal_uuid: this.terminalUuid,
		};
		if (params) body.params = params;

		const { seq, payload } = session.encrypt(Buffer.from(JSON.stringify(body), "utf8"));
		const res = await this.post(`/app/request?seq=${seq}`, payload, session.cookie);
		if (res.status !== 200) {
			this.session = undefined;
			throw new Error(`Device returned HTTP ${res.status} for ${method}`);
		}
		const json = JSON.parse(session.decrypt(seq, res.body).toString("utf8")) as {
			error_code: number;
			result?: unknown;
		};
		if (json.error_code !== 0) {
			throw new Error(`Device error ${json.error_code} for ${method}`);
		}
		return json.result;
	}

	private async getSession(): Promise<KlapSession> {
		if (this.session && Date.now() < this.session.expiresAt) return this.session;
		this.session = await this.handshake();
		return this.session;
	}

	private async handshake(): Promise<KlapSession> {
		const localSeed = randomBytes(16);
		const r1 = await this.post("/app/handshake1", localSeed);
		if (r1.status !== 200 || r1.body.length < 48) {
			throw new Error(`Handshake1 failed (HTTP ${r1.status})`);
		}
		const remoteSeed = r1.body.subarray(0, 16);
		const serverHash = r1.body.subarray(16, 48);

		const cookieMatch = /TP_SESSIONID=([^;]+)/.exec(r1.cookies.join(";"));
		const timeoutMatch = /TIMEOUT=(\d+)/.exec(r1.cookies.join(";"));
		if (!cookieMatch) throw new Error("Handshake1 returned no session cookie");
		const cookie = `TP_SESSIONID=${cookieMatch[1]}`;
		const timeoutSec = timeoutMatch ? Number(timeoutMatch[1]) : 86400;

		let authHash: Buffer;
		let proof: Buffer;
		if (sha256(localSeed, remoteSeed, this.authHashV2).equals(serverHash)) {
			authHash = this.authHashV2;
			proof = sha256(remoteSeed, localSeed, authHash);
		} else if (sha256(localSeed, this.authHashV1).equals(serverHash)) {
			authHash = this.authHashV1;
			proof = sha256(remoteSeed, authHash);
		} else {
			throw new TapoAuthError("Wrong Tapo email or password");
		}

		const r2 = await this.post("/app/handshake2", proof, cookie);
		if (r2.status !== 200) throw new Error(`Handshake2 failed (HTTP ${r2.status})`);

		const seeds = Buffer.concat([localSeed, remoteSeed, authHash]);
		const key = sha256(Buffer.from("lsk"), seeds).subarray(0, 16);
		const ivFull = sha256(Buffer.from("iv"), seeds);
		const sig = sha256(Buffer.from("ldk"), seeds).subarray(0, 28);
		const seq = ivFull.readInt32BE(28);

		// Renew 20 minutes before the device-side timeout, like python-kasa does.
		const expiresAt = Date.now() + Math.max(60, timeoutSec - 1200) * 1000;
		return new KlapSession(cookie, expiresAt, key, ivFull.subarray(0, 12), sig, seq);
	}

	/**
	 * Plain node:http on purpose: the plug's tiny web server answers HTTP 400 to the extra headers
	 * that fetch() (undici) adds, so only send what the protocol needs.
	 */
	private post(path: string, data: Buffer, cookie?: string): Promise<{ status: number; body: Buffer; cookies: string[] }> {
		const headers: Record<string, string | number> = {
			"Content-Type": "application/octet-stream",
			"Content-Length": data.length,
		};
		if (cookie) headers.Cookie = cookie;
		return new Promise((resolve, reject) => {
			const req = request(
				{ host: this.host, port: 80, path, method: "POST", headers, timeout: this.timeoutMs },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							body: Buffer.concat(chunks),
							cookies: res.headers["set-cookie"] ?? [],
						}),
					);
					res.on("error", reject);
				},
			);
			req.on("timeout", () => req.destroy(Object.assign(new Error("Plug not responding"), { name: "TimeoutError" })));
			req.on("error", reject);
			req.end(data);
		});
	}
}
