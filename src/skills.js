import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentError, ConfigError } from './errors.js';

export const SKILL_NAME = 'feedly-cli';

/**
 * Installing is delegated to the `skills` CLI (Vercel Labs, the open agent
 * skills ecosystem) rather than reimplemented here: it knows every harness's
 * skill directory, keeps a lock file, and supports `update`/`remove`.
 *
 * `universal` is the Agent Skills standard target, i.e. `~/.agents/skills`.
 */
export const DEFAULT_SKILL_AGENT = 'universal';
export const SKILLS_PACKAGE = 'skills@latest';
export const SKILLS_TIMEOUT_MS = 300_000;

/** The skill shipped inside this package (`skills/feedly-cli`). */
export function packagedSkillDir() {
    return fileURLToPath(new URL('../skills/feedly-cli', import.meta.url));
}

function readPackageJson() {
    try {
        return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'));
    } catch {
        return {};
    }
}
/**
 * Default source for `skills add` is the skill **bundled in this package**, not
 * the GitHub repository. The npm version and its bundled skill then always
 * travel together, so `feedly skill install` cannot pick up a skill that
 * predates the installed CLI (e.g. when publishing before pushing, or when
 * installing a tag/branch). Pass `--from <owner/repo>` to track the repo
 * instead.
 */
export function defaultSkillSource({ source = packagedSkillDir(), exists = existsSync } = {}) {
    if (!exists(source)) {
        throw new ConfigError(`Bundled skill directory is missing: ${source}`);
    }
    return source;
}

/**
 * `npx -y skills@latest add <source> ... --json`
 *
 * `source` defaults to the bundled skill directory; `--from` overrides it with
 * an `owner/repo`, URL, or path.
 */
export function skillsAddArgs({
    source = defaultSkillSource(),
    skill = SKILL_NAME,
    agent = DEFAULT_SKILL_AGENT,
    global = true,
} = {}) {
    if (!source) {
        throw new ArgumentError(
            'No skill source is known for installation.',
            'Pass --from <owner/repo>, a GitHub URL, or a local path.',
        );
    }
    return [
        '-y', SKILLS_PACKAGE, 'add', source,
        '-s', skill,
        '-a', agent,
        ...(global ? ['-g'] : []),
        '-y', '--json',
    ];
}

/**
 * Upstream update: follows the origin recorded in `~/.agents/.skill-lock.json`
 * (normally the GitHub repo). Only meaningful for GitHub-sourced installs —
 * local-path installs write no lock entry and cannot be updated this way, which
 * is why `feedly skill update` re-syncs from the bundled skill by default.
 */
export function skillsUpdateArgs({ global = true, skill = SKILL_NAME } = {}) {
    return ['-y', SKILLS_PACKAGE, 'update', skill, ...(global ? ['-g'] : []), '-y'];
}

export function skillsRemoveArgs({ global = true, skill = SKILL_NAME } = {}) {
    return ['-y', SKILLS_PACKAGE, 'remove', skill, ...(global ? ['-g'] : []), '-y'];
}

/** Pull the first JSON value out of CLI output that may include a TUI banner. */
export function parseSkillsJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        // fall through: find the outermost JSON array/object
    }
    for (const [open, close] of [['[', ']'], ['{', '}']]) {
        const start = raw.indexOf(open);
        const end = raw.lastIndexOf(close);
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(raw.slice(start, end + 1));
            } catch {
                // keep looking
            }
        }
    }
    return null;
}

/**
 * Run the `skills` CLI. Injectable spawn keeps this unit-testable and lets the
 * CLI surface a clear error when npx is unavailable (e.g. non-npm install).
 */
export function runSkills({
    args,
    spawnImpl = nodeSpawn,
    env = process.env,
    timeout = SKILLS_TIMEOUT_MS,
} = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnImpl('npx', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ code: 127, stdout: '', stderr: err?.message || String(err), spawnFailed: true });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill?.();
            finish({ code: null, stdout, stderr: `${stderr}\n(timed out after ${timeout}ms)`, timedOut: true });
        }, timeout);

        child.stdout?.setEncoding?.('utf-8');
        child.stderr?.setEncoding?.('utf-8');
        child.stdout?.on?.('data', (chunk) => { stdout += chunk; });
        child.stderr?.on?.('data', (chunk) => { stderr += chunk; });
        child.on?.('error', (err) => finish({ code: 127, stdout, stderr: `${stderr}${err?.message || err}`, spawnFailed: true }));
        child.on?.('close', (code) => finish({ code, stdout, stderr }));
    });
}

/** Run a skills subcommand and normalize its JSON (or fail with its output). */
export async function runSkillsAction({ args, spawnImpl, env, timeout } = {}) {
    const result = await runSkills({ args, spawnImpl, env, timeout });
    const payload = parseSkillsJson(result.stdout);
    const failureDetail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n');

    if (result.spawnFailed) {
        throw new ConfigError(
            'Could not run `npx skills`.',
            'Install Node.js/npm, or run the command manually: npx -y skills@latest add <owner/repo> -s feedly-cli -a universal -g',
        );
    }
    if (result.timedOut) {
        throw new ConfigError('The `skills` command timed out.', 'Re-run it manually to see progress: npx -y skills@latest add <owner/repo> -s feedly-cli');
    }
    if (result.code !== 0) {
        throw new ConfigError(
            `\`npx skills\` exited with code ${result.code}.`,
            failureDetail ? `Output:\n${failureDetail}` : 'Re-run the command manually for details.',
        );
    }
    return payload;
}

/** Canonical install location: the Agent Skills standard global directory. */
export function defaultSkillRoot({ home = homedir() } = {}) {
    return join(home, '.agents', 'skills');
}

export function defaultSkillTarget({ home = homedir() } = {}) {
    return join(defaultSkillRoot({ home }), SKILL_NAME);
}

/** Lock file written by the `skills` CLI (global scope). */
export function skillLockPath({ home = homedir() } = {}) {
    return join(home, '.agents', '.skill-lock.json');
}

export function readSkillLock({ home = homedir(), readFile = readFileSync } = {}) {
    try {
        const raw = JSON.parse(readFile(skillLockPath({ home }), 'utf-8'));
        return raw?.skills?.[SKILL_NAME] || null;
    } catch {
        return null;
    }
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

/** Inspect the standard install location plus any lock metadata. */
/** Recorded source for the last install, so `status` can name it. */
export function skillSourceRecordPath({ home = homedir() } = {}) {
    return join(home, '.agents', '.feedly-skill-source.json');
}

function readSourceRecord({ home = homedir(), readFile = readFileSync } = {}) {
    try {
        return JSON.parse(readFile(skillSourceRecordPath({ home }), 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * Stable content hash of a skill directory.
 *
 * Hashes relative paths and file bytes, so it is order-independent and matches
 * the spirit of the `skillFolderHash` recorded by the `skills` CLI lock file.
 */
export function hashSkillDir(dir, { readdir = readdirSync, readFile = readFileSync, stat = statSync } = {}) {
    if (!existsSync(dir)) return '';
    const files = [];
    const walk = (current) => {
        for (const entry of readdir(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) files.push(full);
        }
    };
    walk(dir);
    files.sort();

    const hash = createHash('sha256');
    for (const file of files) {
        if (!stat(file).isFile()) continue;
        hash.update(relative(dir, file).split(sep).join('/'));
        hash.update('\0');
        hash.update(readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

/**
 * Compare the installed skill against the copy bundled with this CLI version.
 * `in-sync` means the installed skill matches the running CLI.
 */
export function skillDrift({
    target,
    source = packagedSkillDir(),
    hash = hashSkillDir,
} = {}) {
    if (!existsSync(join(target, 'SKILL.md'))) return { state: 'not-installed', installedHash: '', bundledHash: '' };
    const installedHash = hash(target);
    const bundledHash = existsSync(source) ? hash(source) : '';
    if (!bundledHash) return { state: 'unknown', installedHash, bundledHash: '' };
    return {
        state: installedHash === bundledHash ? 'in-sync' : 'drifted',
        installedHash,
        bundledHash,
    };
}

export function skillStatus({
    home = homedir(),
    root = defaultSkillRoot({ home }),
    target = join(root, SKILL_NAME),
    source = packagedSkillDir(),
    readFile = readFileSync,
    hash = hashSkillDir,
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
    const lock = installed ? readSkillLock({ home, readFile }) : null;
    const record = readSourceRecord({ home, readFile });
    const drift = installed ? skillDrift({ target, source, hash }) : { state: 'not-installed', installedHash: '', bundledHash: '' };

    return {
        root,
        path: target,
        installed: installed ? 'yes' : 'no',
        mode,
        // Lock origin when installed from GitHub; local record otherwise.
        source: lock?.source || record?.source || '',
        sourceType: lock?.sourceType || record?.sourceType || '',
        updatedAt: lock?.updatedAt || record?.updatedAt || '',
        bundled: source,
        sync: drift.state,
        version: readPackageJson().version || '',
    };
}

export const AGENT_HINT = [
    'AI agents: this CLI ships its own usage skill.',
    '  feedly skill            print the agent instructions (SKILL.md)',
    '  feedly skill list       list bundled skill files',
    '  feedly skill install    install via `skills` into ~/.agents/skills',
    '  feedly skill status     check whether it is installed',
].join('\n');
