// Pure path, remote directory listing, and recent-folder helpers.
// Zero host/UI imports so they can run both inside Herdr mods and in unit tests.

export function normPath(p) {
  if (!p || typeof p !== "string") return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  const slashed = trimmed.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/+$/.test(slashed)) return `${slashed.slice(0, 2)}/`;
  return slashed.replace(/\/+$/, "") || "/";
}

export function joinPath(dir, name) {
  const base = normPath(dir);
  if (!base) return name;
  if (base === "/" || /^[A-Za-z]:\/$/.test(base)) return `${base}${name}`;
  return `${base}/${name}`;
}

export function parentDir(dir) {
  const p = normPath(dir);
  if (!p) return null;
  if (p === "/") return "/";
  if (/^[A-Za-z]:\/?$/.test(p)) return `${p.slice(0, 2)}/`;
  const idx = p.lastIndexOf("/");
  if (idx < 0) return p;
  if (idx === 0) return "/";
  if (idx === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3);
  return p.slice(0, idx);
}

export function expandTilde(p, homeDir) {
  const clean = normPath(p);
  if (!clean) return null;
  const cleanHome = normPath(homeDir);
  if (clean === "~") return cleanHome || "~";
  if (clean.startsWith("~/")) return cleanHome ? joinPath(cleanHome, clean.slice(2)) : clean;
  return clean;
}

function sortRemoteDirs(dirs) {
  const rank = (name) => {
    const lower = name.toLowerCase();
    if (lower === "backlog" || lower === ".backlog") return 0;
    if (lower === "docs") return 1;
    if (name.startsWith(".")) return 3;
    return 2;
  };
  return [...dirs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function parseRemoteDirOutput(stdout, fallbackDir = "/") {
  const fields = String(stdout ?? "").split("\0");
  let dir = normPath(fallbackDir) || "/";
  const dirs = [];
  const mdFiles = [];

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const kind = fields[i];
    const val = fields[i + 1];
    if (!val) continue;
    if (kind === "DIR") {
      dir = normPath(val) || dir;
    } else if (kind === "D") {
      dirs.push(val);
    } else if (kind === "M") {
      mdFiles.push(val);
    }
  }

  return {
    dir,
    dirs: sortRemoteDirs(dirs),
    mdFiles: [...mdFiles].sort((a, b) => a.localeCompare(b)),
  };
}

export function normalizeRecentEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let dir = null;
    let on = null;
    if (typeof item === "string") {
      dir = normPath(item);
    } else if (item && typeof item === "object") {
      dir = normPath(item.dir);
      on = typeof item.on === "string" && item.on ? item.on : null;
    }
    if (!dir) continue;
    const key = `${on ?? ""}\0${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir, on });
  }
  return out;
}

export function filterRecentForMachine(entries, on = null) {
  const target = on || null;
  return normalizeRecentEntries(entries).filter((e) => (e.on ?? null) === target);
}

export function addRecentEntry(entries, dir, on = null, limit = 16) {
  const clean = normPath(dir);
  if (!clean) return normalizeRecentEntries(entries);
  const target = on || null;
  const normalized = normalizeRecentEntries(entries);
  const next = [{ dir: clean, on: target }, ...normalized.filter((e) => !(e.dir === clean && (e.on ?? null) === target))];
  return next.slice(0, limit);
}
