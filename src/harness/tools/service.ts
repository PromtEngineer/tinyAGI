import crypto from 'crypto';
import { hasActivePermission, listPermissions, listTools, upsertPermission, upsertTool } from '../repository';

function classifyTrust(source: string): 'curated' | 'mainstream' | 'unknown' {
    const normalized = source.toLowerCase();
    if (/(github\.com|npmjs\.com|pypi\.org|homebrew\.sh|playwright\.dev|openai\.com)/.test(normalized)) {
        return 'mainstream';
    }
    if (/(internal|local|curated)/.test(normalized)) {
        return 'curated';
    }
    return 'unknown';
}

export function registerTool(name: string, source: string): string {
    const toolId = `tool_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    upsertTool(toolId, name, source, classifyTrust(source), 'pending', {
        reproducibility: 'unknown',
        license: 'unknown',
    });
    return toolId;
}

export function approveTool(name: string, userId: string): string {
    const toolId = `tool_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    upsertTool(toolId, name, 'manual', 'curated', 'approved', {
        approvedBy: userId,
    });
    upsertPermission(`perm_${crypto.randomUUID()}`, userId, name, 'execute', 'tool', 'active');
    return `Tool ${name} approved for ${userId}.`;
}

export function blockTool(name: string, userId: string): string {
    const toolId = `tool_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    upsertTool(toolId, name, 'manual', 'unknown', 'blocked', {
        blockedBy: userId,
    });
    upsertPermission(`perm_${crypto.randomUUID()}`, userId, name, 'execute', 'tool', 'revoked');
    return `Tool ${name} blocked for ${userId}.`;
}

export function toolPermissionStatus(userId: string, name: string): 'active' | 'missing' {
    return hasActivePermission(userId, name, 'execute') ? 'active' : 'missing';
}

export function renderTools(): string {
    const rows = listTools();
    if (rows.length === 0) {
        return 'No tools registered yet.';
    }

    const lines = ['Tool registry:'];
    for (const row of rows) {
        lines.push(`- ${row.name} (${row.tool_id}) status=${row.status} trust=${row.trust_class} source=${row.source || 'n/a'}`);
    }
    return lines.join('\n');
}

export function renderPermissions(userId = ''): string {
    const rows = listPermissions(userId);
    if (rows.length === 0) {
        return userId ? `No permissions found for ${userId}.` : 'No permissions found.';
    }

    const lines = ['Permissions:'];
    for (const row of rows) {
        lines.push(`- ${row.user_id} ${row.subject}:${row.action} status=${row.status} id=${row.permission_id}`);
    }
    return lines.join('\n');
}
