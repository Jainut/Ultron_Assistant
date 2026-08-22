import {
    ProviderError,
    type ProviderHealth,
    type ProviderIdentity,
    type ProviderKind,
    type ProviderRequestContext,
} from "./provider.ts";

export interface ManagedProvider extends ProviderIdentity {
    healthCheck?(context?: ProviderRequestContext): Promise<ProviderHealth>;
}

export class ProviderManager {
    private readonly providers = new Map<string, ManagedProvider>();

    register<TProvider extends ManagedProvider>(provider: TProvider): this {
        if (this.providers.has(provider.id)) {
            throw new ProviderError(`Provider duplicado: ${provider.id}.`, {
                providerId: provider.id,
                code: "validation",
            });
        }

        this.providers.set(provider.id, provider);
        return this;
    }

    unregister(providerId: string): boolean {
        return this.providers.delete(providerId);
    }

    has(providerId: string): boolean {
        return this.providers.has(providerId);
    }

    get<TProvider extends ManagedProvider = ManagedProvider>(providerId: string): TProvider {
        const provider = this.providers.get(providerId);

        if (!provider) {
            throw new ProviderError(`Provider não registrado: ${providerId}.`, {
                providerId,
                code: "not_found",
            });
        }

        return provider as TProvider;
    }

    list(kind?: ProviderKind): readonly ManagedProvider[] {
        const providers = [...this.providers.values()];
        return kind ? providers.filter(provider => provider.kind === kind) : providers;
    }

    async healthCheckAll(
        context?: ProviderRequestContext,
    ): Promise<readonly ProviderHealth[]> {
        return await Promise.all(this.list().map(async provider => {
            if (!provider.healthCheck) {
                return {
                    providerId: provider.id,
                    status: "ready" as const,
                    checkedAt: new Date(),
                };
            }

            try {
                return await provider.healthCheck(context);
            } catch (error) {
                return {
                    providerId: provider.id,
                    status: "unavailable" as const,
                    checkedAt: new Date(),
                    message: error instanceof Error ? error.message : "Provider indisponível.",
                };
            }
        }));
    }
}
