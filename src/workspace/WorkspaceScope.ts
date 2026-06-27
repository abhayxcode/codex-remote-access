import { existsSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export type DirectoryValidation =
  | { ok: true; path: string }
  | { ok: false; message: string };

export class WorkspaceScope {
  constructor(
    public readonly parentDir: string,
    public readonly defaultCwd: string,
  ) {}

  validateDirectory(value: string): DirectoryValidation {
    const path = resolve(value);
    if (!this.isAllowedPath(path)) {
      return { ok: false, message: "Path is outside the allowed parent." };
    }
    if (!existsSync(path)) return { ok: false, message: `Path does not exist:\n${this.displayPath(path)}` };
    const realPath = realpathSync(path);
    if (!this.isAllowedPath(realPath)) {
      return {
        ok: false,
        message: "Path resolves outside the allowed parent.",
      };
    }
    try {
      if (!statSync(realPath).isDirectory()) {
        return { ok: false, message: `Path is not a directory:\n${this.displayPath(realPath)}` };
      }
    } catch {
      return { ok: false, message: `Cannot read directory:\n${this.displayPath(realPath)}` };
    }
    return { ok: true, path: realPath };
  }

  requireAllowedDirectory(value: string) {
    const validation = this.validateDirectory(value);
    if (!validation.ok) throw new Error(validation.message);
    return validation.path;
  }

  requireWorkspaceDirectory(value: string) {
    const path = this.requireAllowedDirectory(value);
    if (path === this.parentDir) {
      throw new Error("Choose a project directory inside / before starting or listing sessions.");
    }
    return path;
  }

  selectedWorkspaceCwd(cwd: string | null | undefined) {
    if (!cwd || cwd === this.parentDir) return this.defaultCwd;
    return cwd;
  }

  isAllowedPath(path: string) {
    const resolvedPath = resolve(path);
    const resolvedParent = resolve(this.parentDir);
    const rel = relative(resolvedParent, resolvedPath);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
  }

  displayPath(path: string) {
    const resolvedPath = resolve(path);
    const rel = relative(this.parentDir, resolvedPath);
    if (rel === "") return "/";
    if (rel.startsWith("..") || rel.startsWith("/")) return "[outside-parent]";
    return `/${rel}`;
  }

  redactPaths(text: string) {
    return String(text).split(this.parentDir).join("");
  }
}
