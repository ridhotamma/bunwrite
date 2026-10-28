// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

export class Proxy {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a list of all the proxy rules. You can use the query params to filter your results.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/databases#querying-documents). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: domain, type, trigger, deploymentResourceType, deploymentResourceId, deploymentId, deploymentVcsProviderBranch
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRuleList>}
     */
    listRules(params?: {
        queries?: string[];
        total?: boolean;
    }): Promise<Models.ProxyRuleList>;
    /**
     * Get a list of all the proxy rules. You can use the query params to filter your results.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/databases#querying-documents). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: domain, type, trigger, deploymentResourceType, deploymentResourceId, deploymentId, deploymentVcsProviderBranch
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRuleList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listRules(
        queries?: string[],
        total?: boolean,
    ): Promise<Models.ProxyRuleList>;
    listRules(
        paramsOrFirst?: { queries?: string[]; total?: boolean } | string[],
        ...rest: [boolean?]
    ): Promise<Models.ProxyRuleList> {
        let params: { queries?: string[]; total?: boolean };

        if (
            !paramsOrFirst ||
            (paramsOrFirst &&
                typeof paramsOrFirst === 'object' &&
                !Array.isArray(paramsOrFirst))
        ) {
            params = (paramsOrFirst || {}) as {
                queries?: string[];
                total?: boolean;
            };
        } else {
            params = {
                queries: paramsOrFirst as string[],
                total: rest[0] as boolean,
            };
        }

        const queries = params.queries;
        const total = params.total;
        const apiPath = '/proxy/rules';
        const apiPayload: Payload = {};
        if (typeof queries !== 'undefined') {
            apiPayload['queries'] = queries;
        }
        if (typeof total !== 'undefined') {
            apiPayload['total'] = total;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Create a new proxy rule for executing Bunwrite Function on custom domain.
     *
     * Rule ID is automatically generated as MD5 hash of a rule domain for performance purposes.
     *
     * @param {string} params.domain - Domain name.
     * @param {string} params.functionId - ID of function to be executed.
     * @param {string} params.branch - Name of VCS branch to deploy changes automatically
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     */
    createFunctionRule(params: {
        domain: string;
        functionId: string;
        branch?: string;
    }): Promise<Models.ProxyRule>;
    /**
     * Create a new proxy rule for executing Bunwrite Function on custom domain.
     *
     * Rule ID is automatically generated as MD5 hash of a rule domain for performance purposes.
     *
     * @param {string} domain - Domain name.
     * @param {string} functionId - ID of function to be executed.
     * @param {string} branch - Name of VCS branch to deploy changes automatically
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createFunctionRule(
        domain: string,
        functionId: string,
        branch?: string,
    ): Promise<Models.ProxyRule>;
    createFunctionRule(
        paramsOrFirst:
            { domain: string; functionId: string; branch?: string } | string,
        ...rest: [string?, string?]
    ): Promise<Models.ProxyRule> {
        let params: { domain: string; functionId: string; branch?: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                domain: string;
                functionId: string;
                branch?: string;
            };
        } else {
            params = {
                domain: paramsOrFirst as string,
                functionId: rest[0] as string,
                branch: rest[1] as string,
            };
        }

        const domain = params.domain;
        const functionId = params.functionId;
        const branch = params.branch;
        if (typeof domain === 'undefined') {
            throw new BunwriteException('Missing required parameter: "domain"');
        }
        if (typeof functionId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "functionId"',
            );
        }
        const apiPath = '/proxy/rules/function';
        const apiPayload: Payload = {};
        if (typeof domain !== 'undefined') {
            apiPayload['domain'] = domain;
        }
        if (typeof functionId !== 'undefined') {
            apiPayload['functionId'] = functionId;
        }
        if (typeof branch !== 'undefined') {
            apiPayload['branch'] = branch;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('post', uri, apiHeaders, apiPayload);
    }

    /**
     * Create a new proxy rule for serving Bunwrite Site on custom domain.
     *
     * Rule ID is automatically generated as MD5 hash of a rule domain for performance purposes.
     *
     * @param {string} params.domain - Domain name.
     * @param {string} params.siteId - ID of site to be executed.
     * @param {string} params.branch - Name of VCS branch to deploy changes automatically
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     */
    createSiteRule(params: {
        domain: string;
        siteId: string;
        branch?: string;
    }): Promise<Models.ProxyRule>;
    /**
     * Create a new proxy rule for serving Bunwrite Site on custom domain.
     *
     * Rule ID is automatically generated as MD5 hash of a rule domain for performance purposes.
     *
     * @param {string} domain - Domain name.
     * @param {string} siteId - ID of site to be executed.
     * @param {string} branch - Name of VCS branch to deploy changes automatically
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createSiteRule(
        domain: string,
        siteId: string,
        branch?: string,
    ): Promise<Models.ProxyRule>;
    createSiteRule(
        paramsOrFirst:
            { domain: string; siteId: string; branch?: string } | string,
        ...rest: [string?, string?]
    ): Promise<Models.ProxyRule> {
        let params: { domain: string; siteId: string; branch?: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                domain: string;
                siteId: string;
                branch?: string;
            };
        } else {
            params = {
                domain: paramsOrFirst as string,
                siteId: rest[0] as string,
                branch: rest[1] as string,
            };
        }

        const domain = params.domain;
        const siteId = params.siteId;
        const branch = params.branch;
        if (typeof domain === 'undefined') {
            throw new BunwriteException('Missing required parameter: "domain"');
        }
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        const apiPath = '/proxy/rules/site';
        const apiPayload: Payload = {};
        if (typeof domain !== 'undefined') {
            apiPayload['domain'] = domain;
        }
        if (typeof siteId !== 'undefined') {
            apiPayload['siteId'] = siteId;
        }
        if (typeof branch !== 'undefined') {
            apiPayload['branch'] = branch;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('post', uri, apiHeaders, apiPayload);
    }

    /**
     * Get a proxy rule by its unique ID.
     *
     * @param {string} params.ruleId - Rule ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     */
    getRule(params: { ruleId: string }): Promise<Models.ProxyRule>;
    /**
     * Get a proxy rule by its unique ID.
     *
     * @param {string} ruleId - Rule ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getRule(ruleId: string): Promise<Models.ProxyRule>;
    getRule(
        paramsOrFirst: { ruleId: string } | string,
    ): Promise<Models.ProxyRule> {
        let params: { ruleId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { ruleId: string };
        } else {
            params = {
                ruleId: paramsOrFirst as string,
            };
        }

        const ruleId = params.ruleId;
        if (typeof ruleId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "ruleId"');
        }
        const apiPath = '/proxy/rules/{ruleId}'.replace(
            '{ruleId}',
            encodeURIComponent(String(ruleId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete a proxy rule by its unique ID.
     *
     * @param {string} params.ruleId - Rule ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteRule(params: { ruleId: string }): Promise<{}>;
    /**
     * Delete a proxy rule by its unique ID.
     *
     * @param {string} ruleId - Rule ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteRule(ruleId: string): Promise<{}>;
    deleteRule(paramsOrFirst: { ruleId: string } | string): Promise<{}> {
        let params: { ruleId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { ruleId: string };
        } else {
            params = {
                ruleId: paramsOrFirst as string,
            };
        }

        const ruleId = params.ruleId;
        if (typeof ruleId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "ruleId"');
        }
        const apiPath = '/proxy/rules/{ruleId}'.replace(
            '{ruleId}',
            encodeURIComponent(String(ruleId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }

    /**
     * If not succeeded yet, retry verification process of a proxy rule domain. This endpoint triggers domain verification by checking DNS records. If verification is successful, a TLS certificate will be automatically provisioned for the domain asynchronously in the background.
     *
     * @param {string} params.ruleId - Rule ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     */
    updateRuleStatus(params: { ruleId: string }): Promise<Models.ProxyRule>;
    /**
     * If not succeeded yet, retry verification process of a proxy rule domain. This endpoint triggers domain verification by checking DNS records. If verification is successful, a TLS certificate will be automatically provisioned for the domain asynchronously in the background.
     *
     * @param {string} ruleId - Rule ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProxyRule>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateRuleStatus(ruleId: string): Promise<Models.ProxyRule>;
    updateRuleStatus(
        paramsOrFirst: { ruleId: string } | string,
    ): Promise<Models.ProxyRule> {
        let params: { ruleId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { ruleId: string };
        } else {
            params = {
                ruleId: paramsOrFirst as string,
            };
        }

        const ruleId = params.ruleId;
        if (typeof ruleId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "ruleId"');
        }
        const apiPath = '/proxy/rules/{ruleId}/status'.replace(
            '{ruleId}',
            encodeURIComponent(String(ruleId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('patch', uri, apiHeaders, apiPayload);
    }
}
