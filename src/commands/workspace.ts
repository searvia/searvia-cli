import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../core/errors.js';
import { isRecord } from '../core/util.js';
import type { Command } from './context.js';
import { searviaClient } from './searvia.js';

interface WorkspaceFile {
  path: string;
  owner: 'searvia' | 'you';
  content: string;
}

interface Project {
  id: number;
  type: string;
  name: string;
}

/** Skills bundled with this package (skills/<name>/SKILL.md), relative to dist/commands or src/commands. */
const SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url));

/** Which bundled skills fit a project: app skills for apps, the rest for websites; AI visibility fits both. */
export function skillsFor(type: string, names: string[]): string[] {
  const app = /^(app-|aso-|apple-ads|competitor-app)/;
  return names.filter((name) => name === 'ai-visibility-audit' || (type === 'web' ? !app.test(name) : app.test(name)));
}

/** Writes Searvia's files every time and the user's files only when they are missing. */
export function writeWorkspace(root: string, files: WorkspaceFile[]): { written: string[]; kept: string[] } {
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(resolve(root))) throw new CliError(`Refusing to write outside the folder: ${file.path}`);
    if (file.owner === 'you' && existsSync(target)) {
      kept.push(file.path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    written.push(file.path);
  }
  return { written, kept };
}

export const workspace: Command = {
  name: 'workspace',
  summary: 'Write a Claude Code workspace for a Searvia project (rules, client, methods, data, log)',
  usage: 'searvia workspace [--project <id>] [--dir <folder>] [--no-skills]',
  description:
    'Gives Claude Code (or any coding agent) your SEO / ASO system as files: CLAUDE.md and AGENTS.md (how to work, approval before changes), client.md, conversions.md, methods.md, workflow.md and wiki.md (yours: written once, never overwritten), log.md (what Searvia proposed, applied and measured), data/ (tracked keywords, Search Console, site audit), .mcp.json (live Searvia tools) and Searvia skills in .claude/skills. Run it again to refresh the data.',
  options: [
    { name: 'project', type: 'number', value: '<id>', description: 'Searvia project id (default: searvia.projectId, or your only project).' },
    { name: 'dir', type: 'string', value: '<folder>', description: 'Folder to write into (default: the current folder).' },
    { name: 'no-skills', type: 'boolean', description: 'Do not copy Searvia skills into .claude/skills.' },
  ],
  examples: ['searvia workspace --project 12', 'searvia workspace --dir seo/acme'],
  async run(context) {
    const client = searviaClient(context);
    const projects = await client.callTool<Project[]>('list_projects');
    const wanted = (context.options.project as number | undefined) ?? context.loaded.config.searvia?.projectId;
    const project = wanted !== undefined ? projects.find((item) => item.id === Number(wanted)) : projects.length === 1 ? projects[0] : undefined;
    if (!project) {
      throw new CliError(wanted !== undefined ? `Searvia project ${wanted} not found.` : 'Which Searvia project?', {
        hint: projects.length ? `Pass --project <id>: ${projects.map((item) => `${item.id} ${item.name}`).join(', ')}` : 'Add a project at https://searvia.com/app.',
      });
    }

    const result = await client.callTool<unknown>('manage_projects', { action: 'workspace', project_id: project.id });
    const data = isRecord(result) && isRecord(result.data) ? result.data : result;
    const files = isRecord(data) && Array.isArray(data.files) ? (data.files as WorkspaceFile[]) : undefined;
    if (!files) throw new CliError('Searvia did not return the workspace files.', { hint: 'Update Searvia access or try again; `searvia mcp` shows the connection.' });

    const root = resolve(context.cwd, String(context.options.dir ?? '.'));
    const { written, kept } = writeWorkspace(root, files);

    const skills: string[] = [];
    if (!context.options.noSkills && existsSync(SKILLS_DIR)) {
      const names = readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
        .map((entry) => entry.name);
      for (const name of skillsFor(project.type, names)) {
        const target = join(root, '.claude', 'skills', `searvia-${name}`, 'SKILL.md');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(SKILLS_DIR, name, 'SKILL.md')));
        skills.push(name);
      }
    }

    context.out.log(`Workspace for ${project.name} in ${root}`);
    context.out.log(`  written: ${written.join(', ')}`);
    if (kept.length) context.out.log(`  kept (yours): ${kept.join(', ')}`);
    if (skills.length) context.out.log(`  skills: ${skills.length} in .claude/skills`);
    context.out.log(context.out.paint('dim', '\nOpen the folder in Claude Code; it reads CLAUDE.md first. Fill in client.md and conversions.md if they still have blanks.'));
    return { project: project.id, root, written, kept, skills };
  },
};
