import { AgentConfig } from '../../lib/types';

export type TaskRoute = 'agent' | 'browser' | 'tooling' | 'memory';

export interface RoutedTask {
    route: TaskRoute;
    reason: string;
}

export function routeTask(message: string, _agent: AgentConfig): RoutedTask {
    const normalized = message.toLowerCase();

    if (/(chrome|browser|open website|navigate|login)/i.test(normalized)) {
        return { route: 'browser', reason: 'Browser operation inferred from message content' };
    }

    if (/(install|tool|plugin|npm|pip|brew)/i.test(normalized)) {
        return { route: 'tooling', reason: 'Tooling operation inferred from message content' };
    }

    if (/(remember|memory|preference|note this)/i.test(normalized)) {
        return { route: 'memory', reason: 'Memory operation inferred from message content' };
    }

    return { route: 'agent', reason: 'Default route to language-model agent' };
}
