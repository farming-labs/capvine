import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { ed25519 } from "@ucanto/principal";

export async function assertPrivateDirectory(path: string): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Private state requires Linux or macOS");
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "State directory must be owned by the service user with mode 0700",
    );
}

export async function readPrivateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 4096
    )
      throw new Error("Invalid private file ownership, mode, type, or size");
    const bytes = Buffer.alloc(4097);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 4096) throw new Error("Private file is too large");
    return bytes.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await file.close();
  }
}

export async function writePrivateFile(
  path: string,
  content: string,
): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function initializeIdentity(path: string) {
  const signer = await ed25519.generate();
  await writePrivateFile(path, ed25519.format(signer));
  return signer;
}

export async function loadIdentity(path: string) {
  const signer = ed25519.parse(await readPrivateFile(path));
  const challenge = randomBytes(32);
  if (!(await signer.verifier.verify(challenge, await signer.sign(challenge))))
    throw new Error("Identity key is inconsistent");
  return signer;
}
