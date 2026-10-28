// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

export class Messaging {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a list of all topics from the current Appwrite project.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, description, emailTotal, smsTotal, pushTotal
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.TopicList>}
     */
    listTopics(params?: {
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.TopicList>;
    /**
     * Get a list of all topics from the current Appwrite project.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, description, emailTotal, smsTotal, pushTotal
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.TopicList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listTopics(
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.TopicList>;
    listTopics(
        paramsOrFirst?:
            { queries?: string[]; search?: string; total?: boolean } | string[],
        ...rest: [string?, boolean?]
    ): Promise<Models.TopicList> {
        let params: { queries?: string[]; search?: string; total?: boolean };

        if (
            !paramsOrFirst ||
            (paramsOrFirst &&
                typeof paramsOrFirst === 'object' &&
                !Array.isArray(paramsOrFirst))
        ) {
            params = (paramsOrFirst || {}) as {
                queries?: string[];
                search?: string;
                total?: boolean;
            };
        } else {
            params = {
                queries: paramsOrFirst as string[],
                search: rest[0] as string,
                total: rest[1] as boolean,
            };
        }

        const queries = params.queries;
        const search = params.search;
        const total = params.total;
        const apiPath = '/messaging/topics';
        const apiPayload: Payload = {};
        if (typeof queries !== 'undefined') {
            apiPayload['queries'] = queries;
        }
        if (typeof search !== 'undefined') {
            apiPayload['search'] = search;
        }
        if (typeof total !== 'undefined') {
            apiPayload['total'] = total;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Create a new topic.
     *
     * @param {string} params.topicId - Topic ID. Choose a custom Topic ID or a new Topic ID.
     * @param {string} params.name - Topic Name.
     * @param {string[]} params.subscribe - An array of role strings with subscribe permission. By default all users are granted with any subscribe permission. [learn more about roles](https://appwrite.io/docs/permissions#permission-roles). Maximum of 100 roles are allowed, each 64 characters long.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Topic>}
     */
    createTopic(params: {
        topicId: string;
        name: string;
        subscribe?: string[];
    }): Promise<Models.Topic>;
    /**
     * Create a new topic.
     *
     * @param {string} topicId - Topic ID. Choose a custom Topic ID or a new Topic ID.
     * @param {string} name - Topic Name.
     * @param {string[]} subscribe - An array of role strings with subscribe permission. By default all users are granted with any subscribe permission. [learn more about roles](https://appwrite.io/docs/permissions#permission-roles). Maximum of 100 roles are allowed, each 64 characters long.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Topic>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createTopic(
        topicId: string,
        name: string,
        subscribe?: string[],
    ): Promise<Models.Topic>;
    createTopic(
        paramsOrFirst:
            { topicId: string; name: string; subscribe?: string[] } | string,
        ...rest: [string?, string[]?]
    ): Promise<Models.Topic> {
        let params: { topicId: string; name: string; subscribe?: string[] };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                topicId: string;
                name: string;
                subscribe?: string[];
            };
        } else {
            params = {
                topicId: paramsOrFirst as string,
                name: rest[0] as string,
                subscribe: rest[1] as string[],
            };
        }

        const topicId = params.topicId;
        const name = params.name;
        const subscribe = params.subscribe;
        if (typeof topicId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "topicId"',
            );
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/messaging/topics';
        const apiPayload: Payload = {};
        if (typeof topicId !== 'undefined') {
            apiPayload['topicId'] = topicId;
        }
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof subscribe !== 'undefined') {
            apiPayload['subscribe'] = subscribe;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('post', uri, apiHeaders, apiPayload);
    }

    /**
     * Get a topic by its unique ID.
     *
     *
     * @param {string} params.topicId - Topic ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Topic>}
     */
    getTopic(params: { topicId: string }): Promise<Models.Topic>;
    /**
     * Get a topic by its unique ID.
     *
     *
     * @param {string} topicId - Topic ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Topic>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getTopic(topicId: string): Promise<Models.Topic>;
    getTopic(
        paramsOrFirst: { topicId: string } | string,
    ): Promise<Models.Topic> {
        let params: { topicId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { topicId: string };
        } else {
            params = {
                topicId: paramsOrFirst as string,
            };
        }

        const topicId = params.topicId;
        if (typeof topicId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "topicId"',
            );
        }
        const apiPath = '/messaging/topics/{topicId}'.replace(
            '{topicId}',
            encodeURIComponent(String(topicId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Update a topic by its unique ID.
     *
     *
     * @param {string} params.topicId - Topic ID.
     * @param {string} params.name - Topic Name.
     * @param {string[]} params.subscribe - An array of role strings with subscribe permission. By default all users are granted with any subscribe permission. [learn more about roles](https://appwrite.io/docs/permissions#permission-roles). Maximum of 100 roles are allowed, each 64 characters long.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Topic>}
     */
    updateTopic(params: {
        topicId: string;
        name?: string;
        subscribe?: string[];
    }): Promise<Models.Topic>;
    /**
     * Update a topic by its unique ID.
     *
     *
     * @param {string} topicId - Topic ID.
     * @param {string} name - Topic Name.
     * @param {string[]} subscribe - An array of role strings with subscribe permission. By default all users are granted with any subscribe permission. [learn more about roles](https://appwrite.io/docs/permissions#permission-roles). Maximum of 100 roles are allowed, each 64 characters long.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Topic>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateTopic(
        topicId: string,
        name?: string,
        subscribe?: string[],
    ): Promise<Models.Topic>;
    updateTopic(
        paramsOrFirst:
            { topicId: string; name?: string; subscribe?: string[] } | string,
        ...rest: [string?, string[]?]
    ): Promise<Models.Topic> {
        let params: { topicId: string; name?: string; subscribe?: string[] };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                topicId: string;
                name?: string;
                subscribe?: string[];
            };
        } else {
            params = {
                topicId: paramsOrFirst as string,
                name: rest[0] as string,
                subscribe: rest[1] as string[],
            };
        }

        const topicId = params.topicId;
        const name = params.name;
        const subscribe = params.subscribe;
        if (typeof topicId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "topicId"',
            );
        }
        const apiPath = '/messaging/topics/{topicId}'.replace(
            '{topicId}',
            encodeURIComponent(String(topicId)),
        );
        const apiPayload: Payload = {};
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof subscribe !== 'undefined') {
            apiPayload['subscribe'] = subscribe;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('patch', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete a topic by its unique ID.
     *
     * @param {string} params.topicId - Topic ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteTopic(params: { topicId: string }): Promise<{}>;
    /**
     * Delete a topic by its unique ID.
     *
     * @param {string} topicId - Topic ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteTopic(topicId: string): Promise<{}>;
    deleteTopic(paramsOrFirst: { topicId: string } | string): Promise<{}> {
        let params: { topicId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { topicId: string };
        } else {
            params = {
                topicId: paramsOrFirst as string,
            };
        }

        const topicId = params.topicId;
        if (typeof topicId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "topicId"',
            );
        }
        const apiPath = '/messaging/topics/{topicId}'.replace(
            '{topicId}',
            encodeURIComponent(String(topicId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }
}
