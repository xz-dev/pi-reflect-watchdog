/**
 * Process-local registry copied from pi-continue-watchdog's proven lifecycle.
 * It elects one current main, tracks attachment busy/idle state, and allows a
 * surviving observer to reclaim ownership after main shutdown.
 */

export type HubAttachmentInstance = object;

export function createHubAttachmentInstance(): HubAttachmentInstance {
	return {};
}

export interface HubAttachmentIdentity {
	readonly sessionId: string;
	readonly hasUI: boolean;
}

export interface HubAttachment {
	readonly id: number;
	readonly identity: HubAttachmentIdentity;
}

export interface HubMainClaim {
	readonly attachmentId: number;
	readonly generation: number;
}

export interface HubMainSnapshot {
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly generation: number;
}

export interface ObservableAgentHubSnapshot {
	readonly revision: number;
	readonly ownershipGeneration: number;
	readonly attachmentCount: number;
	readonly busyCount: number;
	readonly main: HubMainSnapshot | null;
	readonly allObservableIdle: boolean;
}

export interface BindAttachmentInput {
	readonly instance: HubAttachmentInstance;
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly initialBusy?: boolean;
}

export interface BindAttachmentResult {
	readonly attachment: HubAttachment;
	readonly mainClaim: HubMainClaim | null;
}

export interface ObservableAgentHub {
	readonly snapshot: ObservableAgentHubSnapshot;
	bind(input: BindAttachmentInput): BindAttachmentResult;
	markBusy(attachment: HubAttachment): void;
	markIdle(attachment: HubAttachment): void;
	detach(attachment: HubAttachment): void;
	reclaimMain(attachment: HubAttachment): void;
	mainClaimFor(attachment: HubAttachment): HubMainClaim | null;
	isCurrentMain(claim: HubMainClaim): boolean;
	subscribe(listener: () => void): () => void;
}

interface RegisteredAttachment {
	readonly attachment: HubAttachment;
	readonly order: number;
	busy: boolean;
}

class ProcessObservableAgentHub implements ObservableAgentHub {
	private readonly byInstance = new WeakMap<
		HubAttachmentInstance,
		RegisteredAttachment
	>();
	private readonly byId = new Map<number, RegisteredAttachment>();
	private readonly listeners = new Set<() => void>();
	private nextId = 1;
	private nextOrder = 1;
	private nextGeneration = 1;
	private revision = 0;
	private main: { attachment: HubAttachment; generation: number } | undefined;

	get snapshot(): ObservableAgentHubSnapshot {
		return {
			revision: this.revision,
			ownershipGeneration: this.nextGeneration - 1,
			attachmentCount: this.byId.size,
			busyCount: this.busyCount(),
			main: this.mainSnapshot(),
			allObservableIdle: this.main !== undefined && this.busyCount() === 0,
		};
	}

	bind(input: BindAttachmentInput): BindAttachmentResult {
		const existing = this.byInstance.get(input.instance);
		if (existing !== undefined)
			return { attachment: existing.attachment, mainClaim: null };
		const attachment: HubAttachment = {
			id: this.nextId++,
			identity: { sessionId: input.sessionId, hasUI: input.hasUI },
		};
		const registered: RegisteredAttachment = {
			attachment,
			order: this.nextOrder++,
			busy: input.initialBusy === true,
		};
		this.byInstance.set(input.instance, registered);
		this.byId.set(attachment.id, registered);
		let mainClaim: HubMainClaim | null = null;
		if (
			this.main === undefined ||
			(input.hasUI && !this.main.attachment.identity.hasUI)
		)
			mainClaim = this.claim(registered);
		this.changed();
		return { attachment, mainClaim };
	}

	markBusy(attachment: HubAttachment): void {
		const registered = this.registered(attachment);
		if (registered === undefined || registered.busy) return;
		registered.busy = true;
		this.changed();
	}

	markIdle(attachment: HubAttachment): void {
		const registered = this.registered(attachment);
		if (registered === undefined || !registered.busy) return;
		registered.busy = false;
		this.changed();
	}

	detach(attachment: HubAttachment): void {
		const registered = this.registered(attachment);
		if (registered === undefined) return;
		if (this.main?.attachment === attachment) this.main = undefined;
		this.byId.delete(attachment.id);
		this.changed();
	}

	reclaimMain(attachment: HubAttachment): void {
		const registered = this.registered(attachment);
		if (
			registered === undefined ||
			this.main !== undefined ||
			this.preferred() !== registered
		)
			return;
		this.claim(registered);
		this.changed();
	}

	mainClaimFor(attachment: HubAttachment): HubMainClaim | null {
		return this.main?.attachment === attachment
			? { attachmentId: attachment.id, generation: this.main.generation }
			: null;
	}

	isCurrentMain(claim: HubMainClaim): boolean {
		return (
			this.main?.attachment.id === claim.attachmentId &&
			this.main.generation === claim.generation
		);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private claim(registered: RegisteredAttachment): HubMainClaim {
		this.main = {
			attachment: registered.attachment,
			generation: this.nextGeneration++,
		};
		return {
			attachmentId: registered.attachment.id,
			generation: this.main.generation,
		};
	}

	private registered(
		attachment: HubAttachment,
	): RegisteredAttachment | undefined {
		const registered = this.byId.get(attachment.id);
		return registered?.attachment === attachment ? registered : undefined;
	}

	private preferred(): RegisteredAttachment | undefined {
		return [...this.byId.values()].sort(
			(left, right) =>
				Number(right.attachment.identity.hasUI) -
					Number(left.attachment.identity.hasUI) || left.order - right.order,
		)[0];
	}

	private busyCount(): number {
		let count = 0;
		for (const attachment of this.byId.values())
			if (attachment.busy) count += 1;
		return count;
	}

	private mainSnapshot(): HubMainSnapshot | null {
		return this.main === undefined
			? null
			: {
					sessionId: this.main.attachment.identity.sessionId,
					hasUI: this.main.attachment.identity.hasUI,
					generation: this.main.generation,
				};
	}

	private changed(): void {
		this.revision += 1;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Listener cannot corrupt hub state.
			}
		}
	}
}

export function createObservableAgentHub(): ObservableAgentHub {
	return new ProcessObservableAgentHub();
}

export const HUB_SYMBOL = Symbol.for(
	"pi-reflect-watchdog:observable-agent-domain:v2",
);

type HubHost = typeof globalThis & {
	[HUB_SYMBOL]?: ObservableAgentHub;
};

export function getProcessObservableAgentHub(): ObservableAgentHub {
	const host = globalThis as HubHost;
	host[HUB_SYMBOL] ??= createObservableAgentHub();
	return host[HUB_SYMBOL];
}
