import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = join(ROOT, 'skills');
const names = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;

/** The two keys every SKILL.md starts with; strict YAML readers reject a plain value that holds ": ". */
function frontmatter(name: string): { name: string; description: string } {
  const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const block = text.split('\n---')[0]?.replace(/^---\n/, '') ?? '';
  const read = (key: string) =>
    block
      .split('\n')
      .find((line) => line.startsWith(`${key}: `))
      ?.slice(key.length + 2) ?? '';
  const description = read('description');
  return { name: read('name'), description: description.startsWith('"') ? (JSON.parse(description) as string) : description };
}

describe('bundled skills', () => {
  it('match the job skill names of the Searvia panel', () => {
    expect(names.length).toBeGreaterThanOrEqual(19);
    for (const name of names) {
      const meta = frontmatter(name);
      expect(meta.name, name).toBe(name);
      expect(name).toMatch(/^searvia-[a-z0-9-]+$/);
      expect(meta.description.length, name).toBeGreaterThan(40);
      expect(meta.description.includes(': ') && !readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').includes('description: "'), name).toBe(false);
    }
  });

  it('are all listed in the skills README', () => {
    const readme = readFileSync(join(SKILLS, 'README.md'), 'utf8');
    for (const name of names) expect(readme, name).toContain(`./${name}/SKILL.md`);
  });

  it('ship as a Claude Code plugin and a Gemini CLI extension of the same version', () => {
    const version = json('package.json').version;
    expect(json('.claude-plugin/plugin.json').version).toBe(version);
    expect(json('gemini-extension.json').version).toBe(version);
    const marketplace = json('.claude-plugin/marketplace.json') as { plugins: Array<{ name: string; source: string }> };
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'searvia', source: './' })]);
  });
});
