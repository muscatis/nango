import crypto from 'node:crypto';

import { NangoError } from '@nangohq/shared';
import { Err, Ok, getLogger } from '@nangohq/utils';

import type { ThreadsDeletionPayload, ThreadsWebhookPayload, WebhookHandler } from './types.js';

const logger = getLogger('Webhook.Threads');

// https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
function verifyEventSignature(appSecret: string, rawBody: string, signature: string): boolean {
    const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);

    if (expectedBuffer.length !== signatureBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

// https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
// signed_request = base64url(HMAC-SHA256(payload, appSecret)) + '.' + base64url(payload)
// The signature is a raw binary HMAC, not hex.
function parseSignedRequest(signedRequest: string, appSecret: string): ThreadsDeletionPayload {
    const [encodedSig, encodedPayload] = signedRequest.split('.', 2);

    if (!encodedSig || !encodedPayload) {
        throw new Error('invalid signed_request format');
    }

    const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const expectedSig = crypto.createHmac('sha256', appSecret).update(encodedPayload, 'utf8').digest();

    if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
        throw new Error('invalid signed_request signature');
    }

    return JSON.parse(Buffer.from(encodedPayload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const route: WebhookHandler<ThreadsWebhookPayload | { signed_request: string }> = async (nango, headers, body, rawBody) => {
    const appSecret = nango.integration.custom?.['appSecret'];

    // Data deletion callback — signed_request form parameter
    if (typeof body === 'object' && 'signed_request' in body && typeof body.signed_request === 'string') {
        if (!appSecret) {
            logger.error('appSecret not configured for data deletion request', { configId: nango.integration.id });
            return Err(new NangoError('webhook_missing_signature'));
        }

        let deletionPayload: ThreadsDeletionPayload;
        try {
            deletionPayload = parseSignedRequest(body.signed_request, appSecret);
        } catch {
            logger.error('invalid signed_request for data deletion', { configId: nango.integration.id });
            return Err(new NangoError('webhook_invalid_signature'));
        }

        const userId = deletionPayload.user_id;

        const response = await nango.executeScriptForWebhooks({
            body: { type: 'data_deletion', user_id: userId },
            webhookType: 'type',
            connectionIdentifierValue: userId,
            propName: 'connection_config.user_id'
        });

        const connectionId = response?.connectionIds?.[0] ?? userId;

        return Ok({
            content: { url: '', confirmation_code: connectionId },
            statusCode: 200,
            connectionIds: response?.connectionIds || [],
            toForward: { type: 'data_deletion', user_id: userId }
        });
    }

    // Standard event webhook
    const webhookBody = body as ThreadsWebhookPayload;

    if (appSecret) {
        const signature = headers['x-hub-signature-256'];

        if (!signature) {
            logger.error('missing x-hub-signature-256 header', { configId: nango.integration.id });
            return Err(new NangoError('webhook_missing_signature'));
        }

        if (!verifyEventSignature(appSecret, rawBody, signature)) {
            logger.error('invalid x-hub-signature-256', { configId: nango.integration.id });
            return Err(new NangoError('webhook_invalid_signature'));
        }
    }

    const userId: string | undefined = webhookBody.entry?.[0]?.id;

    const response = await nango.executeScriptForWebhooks({
        body: webhookBody,
        webhookType: 'object',
        ...(userId !== undefined ? { connectionIdentifierValue: userId } : {}),
        propName: 'connection_config.user_id'
    });

    return Ok({
        content: { status: 'success' },
        statusCode: 200,
        connectionIds: response?.connectionIds || [],
        toForward: webhookBody
    });
};

export default route;
