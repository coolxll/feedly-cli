import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentError, ConfigError } from '../src/errors.js';
import {
    defaultSkillRoot,
    defaultSkillTarget,
    installSkill,
    listSkillFiles,
    packagedSkillDir,
    readSkillFile,
    skillStatus,
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
        assert.ok(files.includes('SKILL.md'));
        assert.ok(files.includes('references/search-api.md'));
        assert.ok(files.includes('agents/openai.yaml'));
        assert.deepEqual(files, [...files].sort());
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

describe('skill installation', () => {
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

    it('installs a copy into the target directory', () => {
        const target = defaultSkillTarget({ home });
        const result = installSkill({ root: defaultSkillRoot({ home }) });

        assert.equal(result.status, 'installed');
        assert.equal(result.path, target);
        assert.equal(existsSync(join(target, 'SKILL.md')), true);
        assert.match(readFileSync(join(target, 'SKILL.md'), 'utf-8'), /name: feedly-cli/);
        assert.equal(existsSync(join(target, 'references', 'search-api.md')), true);
    });

    it('does not clobber an existing install without --force', () => {
        const root = defaultSkillRoot({ home });
        installSkill({ root });

        assert.equal(installSkill({ root }).status, 'exists');
        assert.equal(installSkill({ root, force: true }).status, 'updated');
    });

    it('supports symlinks and dry runs', () => {
        const root = defaultSkillRoot({ home });

        const dry = installSkill({ root, dryRun: true });
        assert.equal(dry.status, 'would-install');
        assert.equal(existsSync(dry.path), false);

        const linked = installSkill({ root, link: true });
        assert.equal(linked.status, 'installed');
        assert.equal(skillStatus({ root }).mode, 'symlink');
    });

    it('reports status for the target directory', () => {
        const root = defaultSkillRoot({ home });
        assert.equal(skillStatus({ root }).installed, 'no');
        installSkill({ root });
        const status = skillStatus({ root });
        assert.equal(status.installed, 'yes');
        assert.equal(status.mode, 'copy');
    });
});
