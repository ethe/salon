import { createHash } from "node:crypto";
import { basename } from "node:path";

export function generateSalonInstance(workDir: string): string {
	const base = basename(workDir) || "workspace";
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "workspace";
	const id = createHash("sha256").update(workDir).digest("hex").slice(0, 8);
	return `${slug}-${id}`;
}
