// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

import { Region } from '../enums/region';
export class Organization {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a list of all projects. You can use the query params to filter your results.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, teamId, labels, search, accessedAt
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProjectList>}
     */
    listProjects(params?: {
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.ProjectList>;
    /**
     * Get a list of all projects. You can use the query params to filter your results.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, teamId, labels, search, accessedAt
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ProjectList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listProjects(
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.ProjectList>;
    listProjects(
        paramsOrFirst?:
            { queries?: string[]; search?: string; total?: boolean } | string[],
        ...rest: [string?, boolean?]
    ): Promise<Models.ProjectList> {
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
        const apiPath = '/organization/projects';
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
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Create a new project.
     *
     * @param {string} params.projectId - Unique Id. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, and hyphen. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.name - Project name. Max length: 128 chars.
     * @param {Region} params.region - Project Region.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    createProject(params: {
        projectId: string;
        name: string;
        region?: Region;
    }): Promise<Models.Project>;
    /**
     * Create a new project.
     *
     * @param {string} projectId - Unique Id. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, and hyphen. Can't start with a special char. Max length is 36 chars.
     * @param {string} name - Project name. Max length: 128 chars.
     * @param {Region} region - Project Region.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createProject(
        projectId: string,
        name: string,
        region?: Region,
    ): Promise<Models.Project>;
    createProject(
        paramsOrFirst:
            { projectId: string; name: string; region?: Region } | string,
        ...rest: [string?, Region?]
    ): Promise<Models.Project> {
        let params: { projectId: string; name: string; region?: Region };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                projectId: string;
                name: string;
                region?: Region;
            };
        } else {
            params = {
                projectId: paramsOrFirst as string,
                name: rest[0] as string,
                region: rest[1] as Region,
            };
        }

        const projectId = params.projectId;
        const name = params.name;
        const region = params.region;
        if (typeof projectId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "projectId"',
            );
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/organization/projects';
        const apiPayload: Payload = {};
        if (typeof projectId !== 'undefined') {
            apiPayload['projectId'] = projectId;
        }
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof region !== 'undefined') {
            apiPayload['region'] = region;
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
     * Get a project.
     *
     * @param {string} params.projectId - Project unique ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    getProject(params: { projectId: string }): Promise<Models.Project>;
    /**
     * Get a project.
     *
     * @param {string} projectId - Project unique ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getProject(projectId: string): Promise<Models.Project>;
    getProject(
        paramsOrFirst: { projectId: string } | string,
    ): Promise<Models.Project> {
        let params: { projectId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { projectId: string };
        } else {
            params = {
                projectId: paramsOrFirst as string,
            };
        }

        const projectId = params.projectId;
        if (typeof projectId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "projectId"',
            );
        }
        const apiPath = '/organization/projects/{projectId}'.replace(
            '{projectId}',
            encodeURIComponent(String(projectId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Update a project by its unique ID.
     *
     * @param {string} params.projectId - Project unique ID.
     * @param {string} params.name - Project name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateProject(params: {
        projectId: string;
        name: string;
    }): Promise<Models.Project>;
    /**
     * Update a project by its unique ID.
     *
     * @param {string} projectId - Project unique ID.
     * @param {string} name - Project name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateProject(projectId: string, name: string): Promise<Models.Project>;
    updateProject(
        paramsOrFirst: { projectId: string; name: string } | string,
        ...rest: [string?]
    ): Promise<Models.Project> {
        let params: { projectId: string; name: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                projectId: string;
                name: string;
            };
        } else {
            params = {
                projectId: paramsOrFirst as string,
                name: rest[0] as string,
            };
        }

        const projectId = params.projectId;
        const name = params.name;
        if (typeof projectId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "projectId"',
            );
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/organization/projects/{projectId}'.replace(
            '{projectId}',
            encodeURIComponent(String(projectId)),
        );
        const apiPayload: Payload = {};
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('patch', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete a project by its unique ID.
     *
     * @param {string} params.projectId - Project unique ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteProject(params: { projectId: string }): Promise<{}>;
    /**
     * Delete a project by its unique ID.
     *
     * @param {string} projectId - Project unique ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteProject(projectId: string): Promise<{}>;
    deleteProject(paramsOrFirst: { projectId: string } | string): Promise<{}> {
        let params: { projectId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { projectId: string };
        } else {
            params = {
                projectId: paramsOrFirst as string,
            };
        }

        const projectId = params.projectId;
        if (typeof projectId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "projectId"',
            );
        }
        const apiPath = '/organization/projects/{projectId}'.replace(
            '{projectId}',
            encodeURIComponent(String(projectId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }
}
