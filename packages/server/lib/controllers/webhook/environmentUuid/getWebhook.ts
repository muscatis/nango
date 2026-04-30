import * as z from 'zod';

import { accountService, configService, getProvider } from '@nangohq/shared';

import { providerConfigKeySchema } from '../../../helpers/validation.js';

import type { RequestHandler } from 'express';

const paramValidation = z
    .object({
        environmentUuid: z.string().uuid(),
        providerConfigKey: providerConfigKeySchema
    })
    .strict();

const queryValidation = z.object({
    'hub.mode': z.string(),
    'hub.challenge': z.string(),
    'hub.verify_token': z.string()
});

export const getWebhook: RequestHandler = async (req, res) => {
    const paramValue = paramValidation.safeParse(req.params);
    if (!paramValue.success) {
        res.status(400).send({ error: { code: 'invalid_uri_params' } });
        return;
    }

    const queryValue = queryValidation.safeParse(req.query);
    if (!queryValue.success) {
        res.status(400).send({ error: { code: 'invalid_query_params' } });
        return;
    }

    const { environmentUuid, providerConfigKey } = paramValue.data;
    const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': verifyToken } = queryValue.data;

    if (mode !== 'subscribe') {
        res.status(400).send({ error: { code: 'invalid_hub_mode' } });
        return;
    }

    const resEnv = await accountService.getAccountContext({ environmentUuid });
    if (!resEnv) {
        res.status(404).send({ error: { code: 'unknown_environment' } });
        return;
    }

    const { environment } = resEnv;

    const integration = await configService.getProviderConfig(providerConfigKey, environment.id);
    if (!integration) {
        res.status(404).send({ error: { code: 'unknown_provider_config' } });
        return;
    }

    const provider = getProvider(integration.provider);
    if (!provider?.webhook_routing_script) {
        res.status(404).send({ error: { code: 'webhook_not_supported' } });
        return;
    }

    const storedVerifyToken = integration.custom?.['webhookVerifyToken'];
    if (!storedVerifyToken) {
        res.status(403).send({ error: { code: 'webhook_verify_token_not_configured' } });
        return;
    }

    if (storedVerifyToken !== verifyToken) {
        res.status(403).send({ error: { code: 'webhook_verify_token_mismatch' } });
        return;
    }

    res.status(200).send(challenge);
};
