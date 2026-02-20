import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { TINYAGI_HOME } from '../../lib/config';
import { addSkillVersion, listSkillVersions, listSkills, upsertSkill } from '../repository';

const SKILLS_DIR = path.join(TINYAGI_HOME, 'skills');

function ensureSkillsDir(): void {
    if (!fs.existsSync(SKILLS_DIR)) {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
    }
}

export function createSkillDraft(name: string, prompt: string): { skillId: string; path: string } {
    ensureSkillsDir();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const skillId = `skill_${slug || crypto.randomUUID().slice(0, 8)}`;
    const dir = path.join(SKILLS_DIR, skillId);
    fs.mkdirSync(dir, { recursive: true });

    const content = [
        `# ${name}`,
        '',
        '## Intent',
        prompt,
        '',
        '## Activation',
        '- Draft skill generated automatically by tinyAGI harness.',
        '- Requires manual review before activating for autonomous runs.',
    ].join('\n');

    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, content);

    upsertSkill(skillId, name, 'draft', file);
    addSkillVersion(skillId, 1, file, 'Auto-draft created; awaiting review.');

    return { skillId, path: file };
}

export function activateSkill(skillId: string): string {
    const skills = listSkills();
    const found = skills.find(s => s.skill_id === skillId);
    if (!found) return `Skill not found: ${skillId}`;

    upsertSkill(found.skill_id, found.name, 'active', found.draft_path || '');
    return `Skill ${skillId} activated.`;
}

export function disableSkill(skillId: string): string {
    const skills = listSkills();
    const found = skills.find(s => s.skill_id === skillId);
    if (!found) return `Skill not found: ${skillId}`;

    upsertSkill(found.skill_id, found.name, 'disabled', found.draft_path || '');
    return `Skill ${skillId} disabled.`;
}

export function rollbackSkill(skillId: string, version?: number): string {
    const versions = listSkillVersions(skillId);
    if (versions.length === 0) {
        return `No versions found for ${skillId}.`;
    }

    const target = typeof version === 'number'
        ? versions.find(v => v.version === version)
        : versions[0];

    if (!target) return `Version ${version} not found for ${skillId}.`;

    const skills = listSkills();
    const found = skills.find(s => s.skill_id === skillId);
    if (!found) return `Skill not found: ${skillId}`;

    upsertSkill(skillId, found.name, 'active', target.content_path);
    return `Skill ${skillId} rolled back to version ${target.version}.`;
}

export function renderSkills(): string {
    const rows = listSkills();
    if (rows.length === 0) {
        return 'No skills registered.';
    }

    const lines = ['Skills:'];
    for (const row of rows) {
        lines.push(`- ${row.skill_id} (${row.name}) status=${row.status} path=${row.draft_path || 'n/a'}`);
    }
    return lines.join('\n');
}

export function renderSkill(skillId: string): string {
    const rows = listSkills();
    const row = rows.find(r => r.skill_id === skillId);
    if (!row) return `Skill not found: ${skillId}`;

    const versions = listSkillVersions(skillId);
    const lines = [
        `Skill: ${row.skill_id}`,
        `Name: ${row.name}`,
        `Status: ${row.status}`,
        `Path: ${row.draft_path || 'n/a'}`,
        'Versions:',
    ];

    if (versions.length === 0) {
        lines.push('- none');
    } else {
        for (const version of versions) {
            lines.push(`- v${version.version}: ${version.content_path}`);
        }
    }

    return lines.join('\n');
}

export interface AutoSkillDraftInput {
    userId: string;
    runId: string;
    objective: string;
    route: 'agent' | 'browser' | 'tooling' | 'memory';
    verified: boolean;
}

function normalizeName(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function inferSkillName(objective: string, route: AutoSkillDraftInput['route']): string {
    const cleaned = objective
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .trim();
    const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6);
    const prefix = route === 'tooling' ? 'Tooling' : route === 'browser' ? 'Browser' : 'Workflow';
    if (words.length === 0) return `${prefix} Skill`;
    return `${prefix}: ${words.join(' ')}`;
}

function shouldCreateAutoDraft(objective: string, route: AutoSkillDraftInput['route']): boolean {
    const signal = /\b(always|every time|next time|workflow|template|automate|repeat this|do this again)\b/i.test(objective);
    if (signal) return true;
    if (route === 'tooling' && /\binstall|configure|setup|deploy|build\b/i.test(objective)) return true;
    if (route === 'browser' && /\blogin|submit|navigate|portal|dashboard\b/i.test(objective)) return true;
    return false;
}

export function maybeAutoDraftSkill(input: AutoSkillDraftInput): { created: boolean; skillId?: string; path?: string; reason: string } {
    if (!input.verified) {
        return { created: false, reason: 'Run not verified; auto-draft skipped.' };
    }

    if (input.route === 'memory') {
        return { created: false, reason: 'Memory route does not auto-create skills.' };
    }

    if (!shouldCreateAutoDraft(input.objective, input.route)) {
        return { created: false, reason: 'No auto-draft trigger phrase detected.' };
    }

    const name = inferSkillName(input.objective, input.route);
    const existing = listSkills().find(skill => normalizeName(skill.name) === normalizeName(name));
    if (existing) {
        return { created: false, reason: `Similar skill already exists (${existing.skill_id}).` };
    }

    const prompt = [
        `Generated from run ${input.runId} for user ${input.userId}.`,
        `Objective: ${input.objective}`,
        'Capture this as a reusable procedure with guardrails, input requirements, and expected outputs.',
    ].join('\n');

    const draft = createSkillDraft(name, prompt);
    return {
        created: true,
        skillId: draft.skillId,
        path: draft.path,
        reason: 'Auto-draft created from verified repeated/workflow signal.',
    };
}
