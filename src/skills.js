import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentError, ConfigError } from './errors.js';

export const SKILL_NAME = 'feedly-cli';

/**
 * Canonical install location: the Agent Skills standard global directory.
 * Harnesses that read it include pi (`~/.agents/skills`), and Claude Code /
 * Codex / others can point at it from their own settings.
 */
export function defaultSkillRoot({ home = homedir() } = {}) {
    return join(home, '.agents', 'skills');
}

export function defaultSkillTarget({ home = homedir() } = {}) {
    return join(defaultSkillRoot({ home }), SKILL_NAME);
}

/** The skill shipped inside this package (`skills/feedly-cli`). */
export function packagedSkillDir() {
    return fileURLToPath(new URL('../skills/feedly-cli', import.meta.url));
}

/** Recursively list skill files as POSIX-style relative paths. */
export function listSkillFiles(dir = packagedSkillDir()) {
    const files = [];
    const walk = (base, current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(base, full);
            else if (entry.isFile()) files.push(relative(base, full).split(sep).join('/'));
        }
    };
    if (!existsSync(dir)) throw new ConfigError(`Bundled skill directory is missing: ${dir}`);
    walk(dir, dir);
    // Sort globally so SKILL.md leads and output is stable across platforms.
    return files.sort();
}

/**
 * Read a file from the packaged skill. Rejects traversal so that
 * `feedly skill read ../../etc/passwd` cannot escape the skill directory.
 */
export function readSkillFile(relativePath = 'SKILL.md', dir = packagedSkillDir()) {
    const requested = String(relativePath || 'SKILL.md').replace(/^\.\//, '');
    const normalized = normalize(requested).split(sep).join('/');
    if (!normalized || normalized.startsWith('..') || normalized.startsWith('/') || normalized.includes('../')) {
        throw new ArgumentError(`Refusing to read outside the skill directory: ${relativePath}`);
    }
    const full = join(dir, normalized);
    const rel = relative(dir, full);
    if (rel.startsWith('..') || !existsSync(full) || !statSync(full).isFile()) {
        throw new ArgumentError(
            `Unknown skill file: ${relativePath}`,
            `Available files: ${listSkillFiles(dir).join(', ')}`,
        );
    }
    return { path: normalized, content: readFileSync(full, 'utf-8') };
}

/**
 * Copy (or symlink) the bundled skill into a skills directory.
 * Returns `{ status, path, source }` where status is one of
 * `installed` / `updated` / `exists` / `would-install` / `would-update` / `error`.
 */
export function installSkill({
    source = packagedSkillDir(),
    root = defaultSkillRoot(),
    target = join(root, SKILL_NAME),
    force = false,
    link = false,
    dryRun = false,
} = {}) {
    if (!existsSync(source)) throw new ConfigError(`Bundled skill directory is missing: ${source}`);

    const installed = existsSync(target);
    if (installed && !force) return { status: 'exists', path: target, source };
    if (dryRun) return { status: installed ? 'would-update' : 'would-install', path: target, source };

    try {
        if (installed) rmSync(target, { recursive: true, force: true });
        mkdirSync(dirname(target), { recursive: true });
        if (link) symlinkSync(source, target, 'dir');
        else cpSync(source, target, { recursive: true });
        return { status: installed ? 'updated' : 'installed', path: target, source };
    } catch (err) {
        return { status: 'error', path: target, source, error: err?.message || String(err) };
    }
}

/** Inspect one skills directory (default `~/.agents/skills`). */
export function skillStatus({
    root = defaultSkillRoot(),
    target = join(root, SKILL_NAME),
    source = packagedSkillDir(),
} = {}) {
    const installed = existsSync(join(target, 'SKILL.md'));
    let mode = '';
    if (installed) {
        try {
            mode = lstatSync(target).isSymbolicLink() ? 'symlink' : 'copy';
        } catch {
            mode = 'unknown';
        }
    }
    return {
        root,
        path: target,
        installed: installed ? 'yes' : 'no',
        mode,
        source,
    };
}

export const AGENT_HINT = [
    'AI agents: this CLI ships its own usage skill.',
    '  feedly skill            print the agent instructions (SKILL.md)',
    '  feedly skill list       list bundled skill files',
    '  feedly skill install    install into ~/.agents/skills (Agent Skills standard)',
    '  feedly skill status     check whether it is installed',
].join('\n');
