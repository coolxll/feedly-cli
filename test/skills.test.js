import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentError, ConfigError } from '../src/errors.js';
import {
    DEFAULT_SKILL_AGENT,
    defaultSkillRoot,
    defaultSkillSource,
    defaultSkillTarget,
    hashSkillDir,
    listSkillFiles,
    packagedSkillDir,
    parseSkillsJson,
    readSkillFile,
    readSkillLock,
    runSkillsAction,
    skillDrift,
    skillStatus,
    skillsAddArgs,
    skillsRemoveArgs,
    skillsUpdateArgs,
} from '../src/skills.js';

describe('bundled skill files', () => {
    it('ships a SKILL.md with valid frontmatter', () => {
        const { path, content } = readSkillFile();
        assert.equal(path, 'SKILL.md');
        assert.match(content, /^---\nname: feedly-cli\n/);
        assert.match(content, /description: .+feedly/i);
    });

    it('lists the skill files in a stable order', () => {
        const files = listSkillFiles(packagedSkillDir());
        assert.deepEqual(files, ['SKILL.md', 'agents/openai.yaml', 'references/search-api.md']);
    });

    it('reads reference files', () => {
        const { content } = readSkillFile('references/search-api.md');
        assert.match(content, /search\/contents/);
    });

    it('rejects traversal and unknown files', () => {
        assert.throws(() => readSkillFile('../../package.json'), ArgumentError);
        assert.throws(() => readSkillFile('/etc/passwd'), ArgumentError);
        assert.throws(() => readSkillFile('nope.md'), /Unknown skill file/);
    });

    it('throws ConfigError when the packaged directory is absent', () => {
        assert.throws(() => readSkillFile('SKILL.md', '/nonexistent/skill'), ConfigError);
    });
});

describe('skills CLI delegation', () => {
    it('defaults the install source to the bundled skill, not the repo', () => {
        // Regression: using the package.json repository made `skill install`
        // fetch GitHub, which can lag behind the installed npm version.
        assert.equal(defaultSkillSource(), packagedSkillDir());
        assert.equal(skillsAddArgs()[3], packagedSkillDir());
        assert.notEqual(skillsAddArgs()[3], 'coolxll/feedly-cli');
    });

    it('throws when the bundled skill directory is missing', () => {
        assert.throws(() => defaultSkillSource({ source: '/nope/skill', exists: () => false }), ConfigError);
    });

    it('lets --from override the default source', () => {
        assert.equal(skillsAddArgs({ source: 'coolxll/feedly-cli' })[3], 'coolxll/feedly-cli');
    });

    it('builds the documented `skills add` invocation', () => {
        assert.deepEqual(skillsAddArgs({ source: 'coolxll/feedly-cli' }), [
            '-y', 'skills@latest', 'add', 'coolxll/feedly-cli',
            '-s', 'feedly-cli',
            '-a', 'universal',
            '-g', '-y', '--json',
        ]);
        // Project scope drops -g.
        assert.ok(!skillsAddArgs({ source: 'x/y', global: false }).includes('-g'));
        assert.ok(skillsAddArgs({ source: 'x/y', agent: 'claude-code' }).includes('claude-code'));
        assert.equal(DEFAULT_SKILL_AGENT, 'universal');
        assert.throws(() => skillsAddArgs({ source: '' }), ArgumentError);
    });

    it('builds update/remove invocations', () => {
        assert.deepEqual(skillsUpdateArgs(), ['-y', 'skills@latest', 'update', 'feedly-cli', '-g', '-y']);
        assert.deepEqual(skillsRemoveArgs(), ['-y', 'skills@latest', 'remove', 'feedly-cli', '-g', '-y']);
    });

    it('parses JSON even when the CLI prints a banner first', () => {
        assert.deepEqual(parseSkillsJson('[{"status":"installed"}]'), [{ status: 'installed' }]);
        assert.deepEqual(
            parseSkillsJson('● Agent detected\n│\n[{"status":"installed","path":"/x"}]\n'),
            [{ status: 'installed', path: '/x' }],
        );
        assert.deepEqual(parseSkillsJson('{"status":"ok"}'), { status: 'ok' });
        assert.equal(parseSkillsJson(''), null);
        assert.equal(parseSkillsJson('not json at all'), null);
    });

    function fakeSpawn({ code = 0, stdout = '', stderr = '', throwOnSpawn = false } = {}) {
        return () => {
            if (throwOnSpawn) throw new Error('spawn npx ENOENT');
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => {
                if (stdout) child.stdout.emit('data', stdout);
                if (stderr) child.stderr.emit('data', stderr);
                child.emit('close', code);
            });
            return child;
        };
    }

    it('returns parsed JSON on success', async () => {
        const payload = await runSkillsAction({
            args: ['add'],
            spawnImpl: fakeSpawn({ stdout: '[{"status":"installed"}]' }),
        });
        assert.deepEqual(payload, [{ status: 'installed' }]);
    });

    it('surfaces failures with actionable errors', async () => {
        await assert.rejects(
            () => runSkillsAction({ args: ['add'], spawnImpl: fakeSpawn({ code: 1, stderr: 'network down' }) }),
            /exited with code 1/,
        );
        await assert.rejects(
            () => runSkillsAction({ args: ['add'], spawnImpl: fakeSpawn({ throwOnSpawn: true }) }),
            /Could not run `npx skills`/,
        );
    });

    it('treats a successful run without JSON as ok', async () => {
        assert.equal(await runSkillsAction({ args: ['add'], spawnImpl: fakeSpawn({ stdout: 'done' }) }), null);
    });
});

describe('skill status', () => {
    let home;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'feedly-skill-'));
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it('defaults to the Agent Skills standard directory', () => {
        assert.equal(defaultSkillRoot({ home }), join(home, '.agents', 'skills'));
        assert.equal(defaultSkillTarget({ home }), join(home, '.agents', 'skills', 'feedly-cli'));
    });

    it('reports not-installed when nothing is there', () => {
        const status = skillStatus({ home });
        assert.equal(status.installed, 'no');
        assert.equal(status.mode, '');
    });

    it('reports an installed copy with lock metadata', () => {
        const target = defaultSkillTarget({ home });
        mkdirSync(target, { recursive: true });
        cpSync(join(packagedSkillDir(), 'SKILL.md'), join(target, 'SKILL.md'));
        mkdirSync(join(home, '.agents'), { recursive: true });
        writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({
            version: 3,
            skills: { 'feedly-cli': { source: 'coolxll/feedly-cli', updatedAt: '2026-01-01T00:00:00.000Z' } },
        }));

        const status = skillStatus({ home });
        assert.equal(status.installed, 'yes');
        assert.equal(status.mode, 'copy');
        assert.equal(status.source, 'coolxll/feedly-cli');
        assert.equal(status.updatedAt, '2026-01-01T00:00:00.000Z');
    });

    it('reads lock entries defensively', () => {
        assert.equal(readSkillLock({ home }), null);
        mkdirSync(join(home, '.agents'), { recursive: true });
        writeFileSync(join(home, '.agents', '.skill-lock.json'), '{not json');
        assert.equal(readSkillLock({ home }), null);
        assert.equal(existsSync(join(home, '.agents', '.skill-lock.json')), true);
        assert.match(readFileSync(join(packagedSkillDir(), 'SKILL.md'), 'utf-8'), /feedly-cli/);
    });

    describe('drift detection', () => {
        const installBundle = (target) => {
            mkdirSync(target, { recursive: true });
            cpSync(packagedSkillDir(), target, { recursive: true });
        };

        it('hashes directories order-independently', () => {
            const a = join(home, 'a');
            const b = join(home, 'b');
            mkdirSync(a, { recursive: true });
            mkdirSync(b, { recursive: true });
            writeFileSync(join(a, 'SKILL.md'), 'one');
            writeFileSync(join(a, 'ref.md'), 'two');
            writeFileSync(join(b, 'ref.md'), 'two');
            writeFileSync(join(b, 'SKILL.md'), 'one');
            assert.equal(hashSkillDir(a), hashSkillDir(b));
            writeFileSync(join(b, 'ref.md'), 'changed');
            assert.notEqual(hashSkillDir(a), hashSkillDir(b));
        });

        it('reports in-sync when the copy matches the bundled skill', () => {
            const target = defaultSkillTarget({ home });
            installBundle(target);
            assert.equal(skillDrift({ target }).state, 'in-sync');
            assert.equal(skillStatus({ home }).sync, 'in-sync');
        });

        it('reports drifted after the CLI (bundled skill) changes', () => {
            const target = defaultSkillTarget({ home });
            installBundle(target);

            // Simulate an upgraded CLI whose bundled skill moved ahead.
            const bundle = join(home, 'bundle');
            installBundle(bundle);
            writeFileSync(join(bundle, 'SKILL.md'), 'newer instructions\n');

            assert.equal(skillDrift({ target, source: bundle }).state, 'drifted');
            assert.equal(skillStatus({ home, source: bundle }).sync, 'drifted');
        });

        it('reports not-installed and unknown states', () => {
            const target = defaultSkillTarget({ home });
            assert.equal(skillDrift({ target }).state, 'not-installed');
            assert.equal(skillStatus({ home }).sync, 'not-installed');

            installBundle(target);
            assert.equal(skillDrift({ target, source: join(home, 'missing') }).state, 'unknown');
        });
    });
});
