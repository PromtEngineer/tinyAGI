import { RiskLevel } from '../types';

export interface RiskClassification {
    risk: RiskLevel;
    critical: boolean;
    reasons: string[];
}

const PATTERNS: Array<{ regex: RegExp; level: RiskLevel; reason: string }> = [
    { regex: /\b(refactor|edit|patch|fix|implement|write code|change code|commit|pull request|migration)\b/i, level: 'critical', reason: 'Code change request detected' },
    { regex: /\b(install|npm i|pip install|brew install|download executable|script install|new tool)\b/i, level: 'critical', reason: 'Tool install/execution change detected' },
    { regex: /\b(delete|drop|remove permanently|irreversible|transfer|wallet|checkout|pay|payment|purchase|wire)\b/i, level: 'critical', reason: 'Irreversible or payment action detected' },
    { regex: /\b(contract|commitment|promise|deadline|send to client|customer communication|legal)\b/i, level: 'high', reason: 'External commitment detected' },
    { regex: /\b(fact|research|latest|today|financial|medical|legal|security)\b/i, level: 'high', reason: 'High-impact factual domain detected' },
    { regex: /\b(browse|browser|chrome|website|login|account)\b/i, level: 'medium', reason: 'Browser/system action detected' },
];

function rank(level: RiskLevel): number {
    switch (level) {
        case 'low': return 0;
        case 'medium': return 1;
        case 'high': return 2;
        case 'critical': return 3;
        default: return 0;
    }
}

export function classifyRisk(objective: string): RiskClassification {
    let risk: RiskLevel = 'low';
    const reasons: string[] = [];

    for (const pattern of PATTERNS) {
        if (pattern.regex.test(objective)) {
            reasons.push(pattern.reason);
            if (rank(pattern.level) > rank(risk)) {
                risk = pattern.level;
            }
        }
    }

    if (reasons.length === 0) {
        reasons.push('No high-risk keywords detected');
    }

    const critical = risk === 'critical' || risk === 'high';
    return { risk, critical, reasons };
}

export function loopBudgetForRisk(risk: RiskLevel): number {
    if (risk === 'critical' || risk === 'high') return 5;
    if (risk === 'medium') return 3;
    return 1;
}
