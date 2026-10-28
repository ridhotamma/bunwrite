// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

import { TablesDBIndexType } from '../enums/tables-db-index-type';
import { OrderBy } from '../enums/order-by';
export class TablesDB {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a list of all databases from the current Appwrite project. You can use the search parameter to filter your results.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: name
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.DatabaseList>}
     */
    list(params?: {
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.DatabaseList>;
    /**
     * Get a list of all databases from the current Appwrite project. You can use the search parameter to filter your results.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: name
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.DatabaseList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    list(
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.DatabaseList>;
    list(
        paramsOrFirst?:
            { queries?: string[]; search?: string; total?: boolean } | string[],
        ...rest: [string?, boolean?]
    ): Promise<Models.DatabaseList> {
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
        const apiPath = '/tablesdb';
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
     * Create a new Database.
     *
     *
     * @param {string} params.databaseId - Unique Id. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.name - Database name. Max length: 128 chars.
     * @param {boolean} params.enabled - Is the database enabled? When set to 'disabled', users cannot access the database but Server SDKs with an API key can still read and write to the database. No data is lost when this is toggled.
     * @param {string} params.specification - Database specification. Defaults to `serverless`, which creates the database on the shared pool. Any other value provisions a dedicated database on that specification.
     * @param {number} params.replicas - Number of high availability replicas (0-5) for the dedicated database backing this database. Requires a dedicated `specification`; must be 0 for a serverless database. High availability is enabled when greater than 0.
     * @param {string} params.syncMode - Replication sync mode for the dedicated database backing this database. Requires a dedicated `specification`; the mode is only in force once there is at least one replica. Allowed values: async, sync, quorum.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Database>}
     */
    create(params: {
        databaseId: string;
        name: string;
        enabled?: boolean;
        specification?: string;
        replicas?: number;
        syncMode?: string;
    }): Promise<Models.Database>;
    /**
     * Create a new Database.
     *
     *
     * @param {string} databaseId - Unique Id. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} name - Database name. Max length: 128 chars.
     * @param {boolean} enabled - Is the database enabled? When set to 'disabled', users cannot access the database but Server SDKs with an API key can still read and write to the database. No data is lost when this is toggled.
     * @param {string} specification - Database specification. Defaults to `serverless`, which creates the database on the shared pool. Any other value provisions a dedicated database on that specification.
     * @param {number} replicas - Number of high availability replicas (0-5) for the dedicated database backing this database. Requires a dedicated `specification`; must be 0 for a serverless database. High availability is enabled when greater than 0.
     * @param {string} syncMode - Replication sync mode for the dedicated database backing this database. Requires a dedicated `specification`; the mode is only in force once there is at least one replica. Allowed values: async, sync, quorum.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Database>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    create(
        databaseId: string,
        name: string,
        enabled?: boolean,
        specification?: string,
        replicas?: number,
        syncMode?: string,
    ): Promise<Models.Database>;
    create(
        paramsOrFirst:
            | {
                  databaseId: string;
                  name: string;
                  enabled?: boolean;
                  specification?: string;
                  replicas?: number;
                  syncMode?: string;
              }
            | string,
        ...rest: [string?, boolean?, string?, number?, string?]
    ): Promise<Models.Database> {
        let params: {
            databaseId: string;
            name: string;
            enabled?: boolean;
            specification?: string;
            replicas?: number;
            syncMode?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                name: string;
                enabled?: boolean;
                specification?: string;
                replicas?: number;
                syncMode?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                name: rest[0] as string,
                enabled: rest[1] as boolean,
                specification: rest[2] as string,
                replicas: rest[3] as number,
                syncMode: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const name = params.name;
        const enabled = params.enabled;
        const specification = params.specification;
        const replicas = params.replicas;
        const syncMode = params.syncMode;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/tablesdb';
        const apiPayload: Payload = {};
        if (typeof databaseId !== 'undefined') {
            apiPayload['databaseId'] = databaseId;
        }
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
        }
        if (typeof specification !== 'undefined') {
            apiPayload['specification'] = specification;
        }
        if (typeof replicas !== 'undefined') {
            apiPayload['replicas'] = replicas;
        }
        if (typeof syncMode !== 'undefined') {
            apiPayload['syncMode'] = syncMode;
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
     * Get a database by its unique ID. This endpoint response returns a JSON object with the database metadata.
     *
     * @param {string} params.databaseId - Database ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Database>}
     */
    get(params: { databaseId: string }): Promise<Models.Database>;
    /**
     * Get a database by its unique ID. This endpoint response returns a JSON object with the database metadata.
     *
     * @param {string} databaseId - Database ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Database>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    get(databaseId: string): Promise<Models.Database>;
    get(
        paramsOrFirst: { databaseId: string } | string,
    ): Promise<Models.Database> {
        let params: { databaseId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { databaseId: string };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
            };
        }

        const databaseId = params.databaseId;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}'.replace(
            '{databaseId}',
            encodeURIComponent(String(databaseId)),
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
     * Update a database by its unique ID.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.name - Database name. Max length: 128 chars.
     * @param {boolean} params.enabled - Is database enabled? When set to 'disabled', users cannot access the database but Server SDKs with an API key can still read and write to the database. No data is lost when this is toggled.
     * @param {string} params.specification - Database specification. Resizing between dedicated specifications changes cpu, memory, storage and the connection ceiling via a rolling cutover with zero downtime. Moving a `serverless` database onto a dedicated specification is a data migration, not a resize.
     * @param {number} params.replicas - Number of high availability replicas (0-5) for the dedicated database backing this database. Only valid when the database is backed by a dedicated specification. High availability is enabled when greater than 0.
     * @param {string} params.syncMode - Replication sync mode for the dedicated database backing this database. Only valid when the database is backed by a dedicated specification; the mode is only in force once there is at least one replica. Allowed values: async, sync, quorum.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Database>}
     */
    update(params: {
        databaseId: string;
        name?: string;
        enabled?: boolean;
        specification?: string;
        replicas?: number;
        syncMode?: string;
    }): Promise<Models.Database>;
    /**
     * Update a database by its unique ID.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} name - Database name. Max length: 128 chars.
     * @param {boolean} enabled - Is database enabled? When set to 'disabled', users cannot access the database but Server SDKs with an API key can still read and write to the database. No data is lost when this is toggled.
     * @param {string} specification - Database specification. Resizing between dedicated specifications changes cpu, memory, storage and the connection ceiling via a rolling cutover with zero downtime. Moving a `serverless` database onto a dedicated specification is a data migration, not a resize.
     * @param {number} replicas - Number of high availability replicas (0-5) for the dedicated database backing this database. Only valid when the database is backed by a dedicated specification. High availability is enabled when greater than 0.
     * @param {string} syncMode - Replication sync mode for the dedicated database backing this database. Only valid when the database is backed by a dedicated specification; the mode is only in force once there is at least one replica. Allowed values: async, sync, quorum.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Database>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    update(
        databaseId: string,
        name?: string,
        enabled?: boolean,
        specification?: string,
        replicas?: number,
        syncMode?: string,
    ): Promise<Models.Database>;
    update(
        paramsOrFirst:
            | {
                  databaseId: string;
                  name?: string;
                  enabled?: boolean;
                  specification?: string;
                  replicas?: number;
                  syncMode?: string;
              }
            | string,
        ...rest: [string?, boolean?, string?, number?, string?]
    ): Promise<Models.Database> {
        let params: {
            databaseId: string;
            name?: string;
            enabled?: boolean;
            specification?: string;
            replicas?: number;
            syncMode?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                name?: string;
                enabled?: boolean;
                specification?: string;
                replicas?: number;
                syncMode?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                name: rest[0] as string,
                enabled: rest[1] as boolean,
                specification: rest[2] as string,
                replicas: rest[3] as number,
                syncMode: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const name = params.name;
        const enabled = params.enabled;
        const specification = params.specification;
        const replicas = params.replicas;
        const syncMode = params.syncMode;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}'.replace(
            '{databaseId}',
            encodeURIComponent(String(databaseId)),
        );
        const apiPayload: Payload = {};
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
        }
        if (typeof specification !== 'undefined') {
            apiPayload['specification'] = specification;
        }
        if (typeof replicas !== 'undefined') {
            apiPayload['replicas'] = replicas;
        }
        if (typeof syncMode !== 'undefined') {
            apiPayload['syncMode'] = syncMode;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('put', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete a database by its unique ID. Only API keys with with databases.write scope can delete a database.
     *
     * @param {string} params.databaseId - Database ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    delete(params: { databaseId: string }): Promise<{}>;
    /**
     * Delete a database by its unique ID. Only API keys with with databases.write scope can delete a database.
     *
     * @param {string} databaseId - Database ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    delete(databaseId: string): Promise<{}>;
    delete(paramsOrFirst: { databaseId: string } | string): Promise<{}> {
        let params: { databaseId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { databaseId: string };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
            };
        }

        const databaseId = params.databaseId;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}'.replace(
            '{databaseId}',
            encodeURIComponent(String(databaseId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }

    /**
     * Get a list of all tables that belong to the provided databaseId. You can use the search parameter to filter your results.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: name, enabled, rowSecurity
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.TableList>}
     */
    listTables(params: {
        databaseId: string;
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.TableList>;
    /**
     * Get a list of all tables that belong to the provided databaseId. You can use the search parameter to filter your results.
     *
     * @param {string} databaseId - Database ID.
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: name, enabled, rowSecurity
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.TableList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listTables(
        databaseId: string,
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.TableList>;
    listTables(
        paramsOrFirst:
            | {
                  databaseId: string;
                  queries?: string[];
                  search?: string;
                  total?: boolean;
              }
            | string,
        ...rest: [string[]?, string?, boolean?]
    ): Promise<Models.TableList> {
        let params: {
            databaseId: string;
            queries?: string[];
            search?: string;
            total?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                queries?: string[];
                search?: string;
                total?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                queries: rest[0] as string[],
                search: rest[1] as string,
                total: rest[2] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const queries = params.queries;
        const search = params.search;
        const total = params.total;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables'.replace(
            '{databaseId}',
            encodeURIComponent(String(databaseId)),
        );
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
     * Create a new Table. Before using this route, you should create a new database resource using either a [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable) API or directly from your database console.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Unique Id. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.name - Table name. Max length: 128 chars.
     * @param {string[]} params.permissions - An array of permissions strings. By default, no user is granted with any permissions. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} params.rowSecurity - Enables configuring permissions for individual rows. A user needs one of row or table level permissions to access a row. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} params.enabled - Is table enabled? When set to 'disabled', users cannot access the table but Server SDKs with and API key can still read and write to the table. No data is lost when this is toggled.
     * @param {object[]} params.columns - Array of column definitions to create. Each column should contain: key (string), type (string: string, varchar, text, mediumtext, longtext, integer, bigint, double, boolean, datetime, point, linestring, polygon, email, url, ip, enum), size (integer, required for string and varchar types), required (boolean, optional), default (mixed, optional), array (boolean, optional), and type-specific options.
     * @param {object[]} params.indexes - Array of index definitions to create. Each index should contain: key (string), type (string: key, fulltext, unique, spatial), attributes (array of column keys), orders (array of ASC/DESC, optional), and lengths (array of integers, optional).
     * @throws {BunwriteException}
     * @returns {Promise<Models.Table>}
     */
    createTable(params: {
        databaseId: string;
        tableId: string;
        name: string;
        permissions?: string[];
        rowSecurity?: boolean;
        enabled?: boolean;
        columns?: object[];
        indexes?: object[];
    }): Promise<Models.Table>;
    /**
     * Create a new Table. Before using this route, you should create a new database resource using either a [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable) API or directly from your database console.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Unique Id. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} name - Table name. Max length: 128 chars.
     * @param {string[]} permissions - An array of permissions strings. By default, no user is granted with any permissions. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} rowSecurity - Enables configuring permissions for individual rows. A user needs one of row or table level permissions to access a row. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} enabled - Is table enabled? When set to 'disabled', users cannot access the table but Server SDKs with and API key can still read and write to the table. No data is lost when this is toggled.
     * @param {object[]} columns - Array of column definitions to create. Each column should contain: key (string), type (string: string, varchar, text, mediumtext, longtext, integer, bigint, double, boolean, datetime, point, linestring, polygon, email, url, ip, enum), size (integer, required for string and varchar types), required (boolean, optional), default (mixed, optional), array (boolean, optional), and type-specific options.
     * @param {object[]} indexes - Array of index definitions to create. Each index should contain: key (string), type (string: key, fulltext, unique, spatial), attributes (array of column keys), orders (array of ASC/DESC, optional), and lengths (array of integers, optional).
     * @throws {BunwriteException}
     * @returns {Promise<Models.Table>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createTable(
        databaseId: string,
        tableId: string,
        name: string,
        permissions?: string[],
        rowSecurity?: boolean,
        enabled?: boolean,
        columns?: object[],
        indexes?: object[],
    ): Promise<Models.Table>;
    createTable(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  name: string;
                  permissions?: string[];
                  rowSecurity?: boolean;
                  enabled?: boolean;
                  columns?: object[];
                  indexes?: object[];
              }
            | string,
        ...rest: [
            string?,
            string?,
            string[]?,
            boolean?,
            boolean?,
            object[]?,
            object[]?,
        ]
    ): Promise<Models.Table> {
        let params: {
            databaseId: string;
            tableId: string;
            name: string;
            permissions?: string[];
            rowSecurity?: boolean;
            enabled?: boolean;
            columns?: object[];
            indexes?: object[];
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                name: string;
                permissions?: string[];
                rowSecurity?: boolean;
                enabled?: boolean;
                columns?: object[];
                indexes?: object[];
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                name: rest[1] as string,
                permissions: rest[2] as string[],
                rowSecurity: rest[3] as boolean,
                enabled: rest[4] as boolean,
                columns: rest[5] as object[],
                indexes: rest[6] as object[],
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const name = params.name;
        const permissions = params.permissions;
        const rowSecurity = params.rowSecurity;
        const enabled = params.enabled;
        const columns = params.columns;
        const indexes = params.indexes;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/tablesdb/{databaseId}/tables'.replace(
            '{databaseId}',
            encodeURIComponent(String(databaseId)),
        );
        const apiPayload: Payload = {};
        if (typeof tableId !== 'undefined') {
            apiPayload['tableId'] = tableId;
        }
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof permissions !== 'undefined') {
            apiPayload['permissions'] = permissions;
        }
        if (typeof rowSecurity !== 'undefined') {
            apiPayload['rowSecurity'] = rowSecurity;
        }
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
        }
        if (typeof columns !== 'undefined') {
            apiPayload['columns'] = columns;
        }
        if (typeof indexes !== 'undefined') {
            apiPayload['indexes'] = indexes;
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
     * Get a table by its unique ID. This endpoint response returns a JSON object with the table metadata.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Table>}
     */
    getTable(params: {
        databaseId: string;
        tableId: string;
    }): Promise<Models.Table>;
    /**
     * Get a table by its unique ID. This endpoint response returns a JSON object with the table metadata.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Table>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getTable(databaseId: string, tableId: string): Promise<Models.Table>;
    getTable(
        paramsOrFirst: { databaseId: string; tableId: string } | string,
        ...rest: [string?]
    ): Promise<Models.Table> {
        let params: { databaseId: string; tableId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Update a table by its unique ID.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.name - Table name. Max length: 128 chars.
     * @param {string[]} params.permissions - An array of permission strings. By default, the current permissions are inherited. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} params.rowSecurity - Enables configuring permissions for individual rows. A user needs one of row or table-level permissions to access a row. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} params.enabled - Is table enabled? When set to 'disabled', users cannot access the table but Server SDKs with and API key can still read and write to the table. No data is lost when this is toggled.
     * @param {boolean} params.purge - When true, purge all cached list responses for this table as part of the update. Use this to force readers to see fresh data immediately instead of waiting for the cache TTL to expire.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Table>}
     */
    updateTable(params: {
        databaseId: string;
        tableId: string;
        name?: string;
        permissions?: string[];
        rowSecurity?: boolean;
        enabled?: boolean;
        purge?: boolean;
    }): Promise<Models.Table>;
    /**
     * Update a table by its unique ID.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} name - Table name. Max length: 128 chars.
     * @param {string[]} permissions - An array of permission strings. By default, the current permissions are inherited. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} rowSecurity - Enables configuring permissions for individual rows. A user needs one of row or table-level permissions to access a row. [Learn more about permissions](https://appwrite.io/docs/permissions).
     * @param {boolean} enabled - Is table enabled? When set to 'disabled', users cannot access the table but Server SDKs with and API key can still read and write to the table. No data is lost when this is toggled.
     * @param {boolean} purge - When true, purge all cached list responses for this table as part of the update. Use this to force readers to see fresh data immediately instead of waiting for the cache TTL to expire.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Table>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateTable(
        databaseId: string,
        tableId: string,
        name?: string,
        permissions?: string[],
        rowSecurity?: boolean,
        enabled?: boolean,
        purge?: boolean,
    ): Promise<Models.Table>;
    updateTable(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  name?: string;
                  permissions?: string[];
                  rowSecurity?: boolean;
                  enabled?: boolean;
                  purge?: boolean;
              }
            | string,
        ...rest: [string?, string?, string[]?, boolean?, boolean?, boolean?]
    ): Promise<Models.Table> {
        let params: {
            databaseId: string;
            tableId: string;
            name?: string;
            permissions?: string[];
            rowSecurity?: boolean;
            enabled?: boolean;
            purge?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                name?: string;
                permissions?: string[];
                rowSecurity?: boolean;
                enabled?: boolean;
                purge?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                name: rest[1] as string,
                permissions: rest[2] as string[],
                rowSecurity: rest[3] as boolean,
                enabled: rest[4] as boolean,
                purge: rest[5] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const name = params.name;
        const permissions = params.permissions;
        const rowSecurity = params.rowSecurity;
        const enabled = params.enabled;
        const purge = params.purge;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof permissions !== 'undefined') {
            apiPayload['permissions'] = permissions;
        }
        if (typeof rowSecurity !== 'undefined') {
            apiPayload['rowSecurity'] = rowSecurity;
        }
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
        }
        if (typeof purge !== 'undefined') {
            apiPayload['purge'] = purge;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('put', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete a table by its unique ID. Only users with write permissions have access to delete this resource.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteTable(params: { databaseId: string; tableId: string }): Promise<{}>;
    /**
     * Delete a table by its unique ID. Only users with write permissions have access to delete this resource.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteTable(databaseId: string, tableId: string): Promise<{}>;
    deleteTable(
        paramsOrFirst: { databaseId: string; tableId: string } | string,
        ...rest: [string?]
    ): Promise<{}> {
        let params: { databaseId: string; tableId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }

    /**
     * List columns in the table.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: key, type, size, required, array, status, error
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnList>}
     */
    listColumns(params: {
        databaseId: string;
        tableId: string;
        queries?: string[];
        total?: boolean;
    }): Promise<Models.ColumnList>;
    /**
     * List columns in the table.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: key, type, size, required, array, status, error
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listColumns(
        databaseId: string,
        tableId: string,
        queries?: string[],
        total?: boolean,
    ): Promise<Models.ColumnList>;
    listColumns(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  queries?: string[];
                  total?: boolean;
              }
            | string,
        ...rest: [string?, string[]?, boolean?]
    ): Promise<Models.ColumnList> {
        let params: {
            databaseId: string;
            tableId: string;
            queries?: string[];
            total?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                queries?: string[];
                total?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                queries: rest[1] as string[],
                total: rest[2] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const queries = params.queries;
        const total = params.total;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof queries !== 'undefined') {
            apiPayload['queries'] = queries;
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
     * Create a bigint column. Optionally, minimum and maximum values can be provided.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {number | bigint} params.min - Minimum value
     * @param {number | bigint} params.max - Maximum value
     * @param {number | bigint} params.xdefault - Default value. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBigint>}
     */
    createBigIntColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        min?: number | bigint;
        max?: number | bigint;
        xdefault?: number | bigint;
        array?: boolean;
    }): Promise<Models.ColumnBigint>;
    /**
     * Create a bigint column. Optionally, minimum and maximum values can be provided.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {number | bigint} min - Minimum value
     * @param {number | bigint} max - Maximum value
     * @param {number | bigint} xdefault - Default value. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBigint>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createBigIntColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        min?: number | bigint,
        max?: number | bigint,
        xdefault?: number | bigint,
        array?: boolean,
    ): Promise<Models.ColumnBigint>;
    createBigIntColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  min?: number | bigint;
                  max?: number | bigint;
                  xdefault?: number | bigint;
                  array?: boolean;
              }
            | string,
        ...rest: [
            string?,
            string?,
            boolean?,
            (number | bigint)?,
            (number | bigint)?,
            (number | bigint)?,
            boolean?,
        ]
    ): Promise<Models.ColumnBigint> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            min?: number | bigint;
            max?: number | bigint;
            xdefault?: number | bigint;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                min?: number | bigint;
                max?: number | bigint;
                xdefault?: number | bigint;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                min: rest[3] as number | bigint,
                max: rest[4] as number | bigint,
                xdefault: rest[5] as number | bigint,
                array: rest[6] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const min = params.min;
        const max = params.max;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/bigint'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof min !== 'undefined') {
            apiPayload['min'] = min;
        }
        if (typeof max !== 'undefined') {
            apiPayload['max'] = max;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update a bigint column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {number | bigint} params.xdefault - Default value. Cannot be set when column is required.
     * @param {number | bigint} params.min - Minimum value
     * @param {number | bigint} params.max - Maximum value
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBigint>}
     */
    updateBigIntColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: number | bigint;
        min?: number | bigint;
        max?: number | bigint;
        newKey?: string;
    }): Promise<Models.ColumnBigint>;
    /**
     * Update a bigint column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {number | bigint} xdefault - Default value. Cannot be set when column is required.
     * @param {number | bigint} min - Minimum value
     * @param {number | bigint} max - Maximum value
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBigint>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateBigIntColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: number | bigint,
        min?: number | bigint,
        max?: number | bigint,
        newKey?: string,
    ): Promise<Models.ColumnBigint>;
    updateBigIntColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: number | bigint;
                  min?: number | bigint;
                  max?: number | bigint;
                  newKey?: string;
              }
            | string,
        ...rest: [
            string?,
            string?,
            boolean?,
            (number | bigint)?,
            (number | bigint)?,
            (number | bigint)?,
            string?,
        ]
    ): Promise<Models.ColumnBigint> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: number | bigint;
            min?: number | bigint;
            max?: number | bigint;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: number | bigint;
                min?: number | bigint;
                max?: number | bigint;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as number | bigint,
                min: rest[4] as number | bigint,
                max: rest[5] as number | bigint,
                newKey: rest[6] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const min = params.min;
        const max = params.max;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/bigint/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof min !== 'undefined') {
            apiPayload['min'] = min;
        }
        if (typeof max !== 'undefined') {
            apiPayload['max'] = max;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a boolean column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {boolean} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBoolean>}
     */
    createBooleanColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: boolean;
        array?: boolean;
    }): Promise<Models.ColumnBoolean>;
    /**
     * Create a boolean column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {boolean} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBoolean>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createBooleanColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: boolean,
        array?: boolean,
    ): Promise<Models.ColumnBoolean>;
    createBooleanColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: boolean;
                  array?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, boolean?, boolean?]
    ): Promise<Models.ColumnBoolean> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: boolean;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: boolean;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as boolean,
                array: rest[4] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/boolean'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update a boolean column. Changing the `default` value will not update already existing rows.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {boolean} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBoolean>}
     */
    updateBooleanColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: boolean;
        newKey?: string;
    }): Promise<Models.ColumnBoolean>;
    /**
     * Update a boolean column. Changing the `default` value will not update already existing rows.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {boolean} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBoolean>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateBooleanColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: boolean,
        newKey?: string,
    ): Promise<Models.ColumnBoolean>;
    updateBooleanColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: boolean;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, boolean?, string?]
    ): Promise<Models.ColumnBoolean> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: boolean;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: boolean;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as boolean,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/boolean/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a date time column according to the ISO 8601 standard.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for the column in [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html) format. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnDatetime>}
     */
    createDatetimeColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
    }): Promise<Models.ColumnDatetime>;
    /**
     * Create a date time column according to the ISO 8601 standard.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for the column in [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html) format. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnDatetime>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createDatetimeColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
    ): Promise<Models.ColumnDatetime>;
    createDatetimeColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?]
    ): Promise<Models.ColumnDatetime> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/datetime'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update a date time column. Changing the `default` value will not update already existing rows.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnDatetime>}
     */
    updateDatetimeColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnDatetime>;
    /**
     * Update a date time column. Changing the `default` value will not update already existing rows.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnDatetime>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateDatetimeColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnDatetime>;
    updateDatetimeColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnDatetime> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/datetime/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create an email column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEmail>}
     */
    createEmailColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
    }): Promise<Models.ColumnEmail>;
    /**
     * Create an email column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEmail>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createEmailColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
    ): Promise<Models.ColumnEmail>;
    createEmailColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?]
    ): Promise<Models.ColumnEmail> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/email'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update an email column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEmail>}
     */
    updateEmailColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnEmail>;
    /**
     * Update an email column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEmail>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEmailColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnEmail>;
    updateEmailColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnEmail> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/email/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create an enumeration column. The `elements` param acts as a white-list of accepted values for this column.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {string[]} params.elements - Array of enum values.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEnum>}
     */
    createEnumColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        elements: string[];
        required: boolean;
        xdefault?: string;
        array?: boolean;
    }): Promise<Models.ColumnEnum>;
    /**
     * Create an enumeration column. The `elements` param acts as a white-list of accepted values for this column.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {string[]} elements - Array of enum values.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEnum>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createEnumColumn(
        databaseId: string,
        tableId: string,
        key: string,
        elements: string[],
        required: boolean,
        xdefault?: string,
        array?: boolean,
    ): Promise<Models.ColumnEnum>;
    createEnumColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  elements: string[];
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
              }
            | string,
        ...rest: [string?, string?, string[]?, boolean?, string?, boolean?]
    ): Promise<Models.ColumnEnum> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            elements: string[];
            required: boolean;
            xdefault?: string;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                elements: string[];
                required: boolean;
                xdefault?: string;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                elements: rest[2] as string[],
                required: rest[3] as boolean,
                xdefault: rest[4] as string,
                array: rest[5] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const elements = params.elements;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof elements === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "elements"',
            );
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/enum'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof elements !== 'undefined') {
            apiPayload['elements'] = elements;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update an enum column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {string[]} params.elements - Updated list of enum values.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEnum>}
     */
    updateEnumColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        elements: string[];
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnEnum>;
    /**
     * Update an enum column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {string[]} elements - Updated list of enum values.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnEnum>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEnumColumn(
        databaseId: string,
        tableId: string,
        key: string,
        elements: string[],
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnEnum>;
    updateEnumColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  elements: string[];
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, string[]?, boolean?, string?, string?]
    ): Promise<Models.ColumnEnum> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            elements: string[];
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                elements: string[];
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                elements: rest[2] as string[],
                required: rest[3] as boolean,
                xdefault: rest[4] as string,
                newKey: rest[5] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const elements = params.elements;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof elements === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "elements"',
            );
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/enum/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof elements !== 'undefined') {
            apiPayload['elements'] = elements;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a float column. Optionally, minimum and maximum values can be provided.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {number} params.min - Minimum value
     * @param {number} params.max - Maximum value
     * @param {number} params.xdefault - Default value. Cannot be set when required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnFloat>}
     */
    createFloatColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        min?: number;
        max?: number;
        xdefault?: number;
        array?: boolean;
    }): Promise<Models.ColumnFloat>;
    /**
     * Create a float column. Optionally, minimum and maximum values can be provided.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {number} min - Minimum value
     * @param {number} max - Maximum value
     * @param {number} xdefault - Default value. Cannot be set when required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnFloat>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createFloatColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        min?: number,
        max?: number,
        xdefault?: number,
        array?: boolean,
    ): Promise<Models.ColumnFloat>;
    createFloatColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  min?: number;
                  max?: number;
                  xdefault?: number;
                  array?: boolean;
              }
            | string,
        ...rest: [
            string?,
            string?,
            boolean?,
            number?,
            number?,
            number?,
            boolean?,
        ]
    ): Promise<Models.ColumnFloat> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            min?: number;
            max?: number;
            xdefault?: number;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                min?: number;
                max?: number;
                xdefault?: number;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                min: rest[3] as number,
                max: rest[4] as number,
                xdefault: rest[5] as number,
                array: rest[6] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const min = params.min;
        const max = params.max;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/float'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof min !== 'undefined') {
            apiPayload['min'] = min;
        }
        if (typeof max !== 'undefined') {
            apiPayload['max'] = max;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update a float column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {number} params.xdefault - Default value. Cannot be set when required.
     * @param {number} params.min - Minimum value
     * @param {number} params.max - Maximum value
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnFloat>}
     */
    updateFloatColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: number;
        min?: number;
        max?: number;
        newKey?: string;
    }): Promise<Models.ColumnFloat>;
    /**
     * Update a float column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {number} xdefault - Default value. Cannot be set when required.
     * @param {number} min - Minimum value
     * @param {number} max - Maximum value
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnFloat>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateFloatColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: number,
        min?: number,
        max?: number,
        newKey?: string,
    ): Promise<Models.ColumnFloat>;
    updateFloatColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: number;
                  min?: number;
                  max?: number;
                  newKey?: string;
              }
            | string,
        ...rest: [
            string?,
            string?,
            boolean?,
            number?,
            number?,
            number?,
            string?,
        ]
    ): Promise<Models.ColumnFloat> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: number;
            min?: number;
            max?: number;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: number;
                min?: number;
                max?: number;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as number,
                min: rest[4] as number,
                max: rest[5] as number,
                newKey: rest[6] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const min = params.min;
        const max = params.max;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/float/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof min !== 'undefined') {
            apiPayload['min'] = min;
        }
        if (typeof max !== 'undefined') {
            apiPayload['max'] = max;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create an integer column. Optionally, minimum and maximum values can be provided.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {number | bigint} params.min - Minimum value
     * @param {number | bigint} params.max - Maximum value
     * @param {number | bigint} params.xdefault - Default value. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnInteger>}
     */
    createIntegerColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        min?: number | bigint;
        max?: number | bigint;
        xdefault?: number | bigint;
        array?: boolean;
    }): Promise<Models.ColumnInteger>;
    /**
     * Create an integer column. Optionally, minimum and maximum values can be provided.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {number | bigint} min - Minimum value
     * @param {number | bigint} max - Maximum value
     * @param {number | bigint} xdefault - Default value. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnInteger>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createIntegerColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        min?: number | bigint,
        max?: number | bigint,
        xdefault?: number | bigint,
        array?: boolean,
    ): Promise<Models.ColumnInteger>;
    createIntegerColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  min?: number | bigint;
                  max?: number | bigint;
                  xdefault?: number | bigint;
                  array?: boolean;
              }
            | string,
        ...rest: [
            string?,
            string?,
            boolean?,
            (number | bigint)?,
            (number | bigint)?,
            (number | bigint)?,
            boolean?,
        ]
    ): Promise<Models.ColumnInteger> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            min?: number | bigint;
            max?: number | bigint;
            xdefault?: number | bigint;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                min?: number | bigint;
                max?: number | bigint;
                xdefault?: number | bigint;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                min: rest[3] as number | bigint,
                max: rest[4] as number | bigint,
                xdefault: rest[5] as number | bigint,
                array: rest[6] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const min = params.min;
        const max = params.max;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/integer'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof min !== 'undefined') {
            apiPayload['min'] = min;
        }
        if (typeof max !== 'undefined') {
            apiPayload['max'] = max;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update an integer column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {number | bigint} params.xdefault - Default value. Cannot be set when column is required.
     * @param {number | bigint} params.min - Minimum value
     * @param {number | bigint} params.max - Maximum value
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnInteger>}
     */
    updateIntegerColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: number | bigint;
        min?: number | bigint;
        max?: number | bigint;
        newKey?: string;
    }): Promise<Models.ColumnInteger>;
    /**
     * Update an integer column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {number | bigint} xdefault - Default value. Cannot be set when column is required.
     * @param {number | bigint} min - Minimum value
     * @param {number | bigint} max - Maximum value
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnInteger>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateIntegerColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: number | bigint,
        min?: number | bigint,
        max?: number | bigint,
        newKey?: string,
    ): Promise<Models.ColumnInteger>;
    updateIntegerColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: number | bigint;
                  min?: number | bigint;
                  max?: number | bigint;
                  newKey?: string;
              }
            | string,
        ...rest: [
            string?,
            string?,
            boolean?,
            (number | bigint)?,
            (number | bigint)?,
            (number | bigint)?,
            string?,
        ]
    ): Promise<Models.ColumnInteger> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: number | bigint;
            min?: number | bigint;
            max?: number | bigint;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: number | bigint;
                min?: number | bigint;
                max?: number | bigint;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as number | bigint,
                min: rest[4] as number | bigint,
                max: rest[5] as number | bigint,
                newKey: rest[6] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const min = params.min;
        const max = params.max;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/integer/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof min !== 'undefined') {
            apiPayload['min'] = min;
        }
        if (typeof max !== 'undefined') {
            apiPayload['max'] = max;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create IP address column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIp>}
     */
    createIpColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
    }): Promise<Models.ColumnIp>;
    /**
     * Create IP address column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIp>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createIpColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
    ): Promise<Models.ColumnIp>;
    createIpColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?]
    ): Promise<Models.ColumnIp> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/ip'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update an ip column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIp>}
     */
    updateIpColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnIp>;
    /**
     * Update an ip column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIp>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateIpColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnIp>;
    updateIpColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnIp> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/ip/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a longtext column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @param {boolean} params.encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnLongtext>}
     */
    createLongtextColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
        encrypt?: boolean;
    }): Promise<Models.ColumnLongtext>;
    /**
     * Create a longtext column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @param {boolean} encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnLongtext>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createLongtextColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
        encrypt?: boolean,
    ): Promise<Models.ColumnLongtext>;
    createLongtextColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
                  encrypt?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?, boolean?]
    ): Promise<Models.ColumnLongtext> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
            encrypt?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
                encrypt?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
                encrypt: rest[5] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        const encrypt = params.encrypt;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/longtext'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
        }
        if (typeof encrypt !== 'undefined') {
            apiPayload['encrypt'] = encrypt;
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
     * Update a longtext column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnLongtext>}
     */
    updateLongtextColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnLongtext>;
    /**
     * Update a longtext column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnLongtext>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateLongtextColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnLongtext>;
    updateLongtextColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnLongtext> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/longtext/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a mediumtext column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @param {boolean} params.encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnMediumtext>}
     */
    createMediumtextColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
        encrypt?: boolean;
    }): Promise<Models.ColumnMediumtext>;
    /**
     * Create a mediumtext column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @param {boolean} encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnMediumtext>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createMediumtextColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
        encrypt?: boolean,
    ): Promise<Models.ColumnMediumtext>;
    createMediumtextColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
                  encrypt?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?, boolean?]
    ): Promise<Models.ColumnMediumtext> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
            encrypt?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
                encrypt?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
                encrypt: rest[5] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        const encrypt = params.encrypt;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/mediumtext'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
        }
        if (typeof encrypt !== 'undefined') {
            apiPayload['encrypt'] = encrypt;
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
     * Update a mediumtext column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnMediumtext>}
     */
    updateMediumtextColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnMediumtext>;
    /**
     * Update a mediumtext column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnMediumtext>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateMediumtextColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnMediumtext>;
    updateMediumtextColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnMediumtext> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/mediumtext/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a string column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {number} params.size - Column size for text columns, in number of characters.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @param {boolean} params.encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnString>}
     * @deprecated This API has been deprecated since 1.9.0. Please use `TablesDB.createTextColumn` instead.
     */
    createStringColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        size: number;
        required: boolean;
        xdefault?: string;
        array?: boolean;
        encrypt?: boolean;
    }): Promise<Models.ColumnString>;
    /**
     * Create a string column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {number} size - Column size for text columns, in number of characters.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @param {boolean} encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnString>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createStringColumn(
        databaseId: string,
        tableId: string,
        key: string,
        size: number,
        required: boolean,
        xdefault?: string,
        array?: boolean,
        encrypt?: boolean,
    ): Promise<Models.ColumnString>;
    createStringColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  size: number;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
                  encrypt?: boolean;
              }
            | string,
        ...rest: [
            string?,
            string?,
            number?,
            boolean?,
            string?,
            boolean?,
            boolean?,
        ]
    ): Promise<Models.ColumnString> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            size: number;
            required: boolean;
            xdefault?: string;
            array?: boolean;
            encrypt?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                size: number;
                required: boolean;
                xdefault?: string;
                array?: boolean;
                encrypt?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                size: rest[2] as number,
                required: rest[3] as boolean,
                xdefault: rest[4] as string,
                array: rest[5] as boolean,
                encrypt: rest[6] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const size = params.size;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        const encrypt = params.encrypt;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof size === 'undefined') {
            throw new BunwriteException('Missing required parameter: "size"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/string'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof size !== 'undefined') {
            apiPayload['size'] = size;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
        }
        if (typeof encrypt !== 'undefined') {
            apiPayload['encrypt'] = encrypt;
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
     * Update a string column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {number} params.size - Maximum size of the string column.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnString>}
     * @deprecated This API has been deprecated since 1.8.0. Please use `TablesDB.updateTextColumn` instead.
     */
    updateStringColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        size?: number;
        newKey?: string;
    }): Promise<Models.ColumnString>;
    /**
     * Update a string column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {number} size - Maximum size of the string column.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnString>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateStringColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        size?: number,
        newKey?: string,
    ): Promise<Models.ColumnString>;
    updateStringColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  size?: number;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, number?, string?]
    ): Promise<Models.ColumnString> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            size?: number;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                size?: number;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                size: rest[4] as number,
                newKey: rest[5] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const size = params.size;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/string/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof size !== 'undefined') {
            apiPayload['size'] = size;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a text column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @param {boolean} params.encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnText>}
     */
    createTextColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
        encrypt?: boolean;
    }): Promise<Models.ColumnText>;
    /**
     * Create a text column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @param {boolean} encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnText>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createTextColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
        encrypt?: boolean,
    ): Promise<Models.ColumnText>;
    createTextColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
                  encrypt?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?, boolean?]
    ): Promise<Models.ColumnText> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
            encrypt?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
                encrypt?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
                encrypt: rest[5] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        const encrypt = params.encrypt;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/text'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
        }
        if (typeof encrypt !== 'undefined') {
            apiPayload['encrypt'] = encrypt;
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
     * Update a text column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnText>}
     */
    updateTextColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnText>;
    /**
     * Update a text column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnText>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateTextColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnText>;
    updateTextColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnText> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/text/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a URL column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnUrl>}
     */
    createUrlColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        array?: boolean;
    }): Promise<Models.ColumnUrl>;
    /**
     * Create a URL column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnUrl>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createUrlColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        array?: boolean,
    ): Promise<Models.ColumnUrl>;
    createUrlColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, boolean?]
    ): Promise<Models.ColumnUrl> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            array?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                array?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                array: rest[4] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/url'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
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
     * Update an url column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnUrl>}
     */
    updateUrlColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        newKey?: string;
    }): Promise<Models.ColumnUrl>;
    /**
     * Update an url column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnUrl>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateUrlColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        newKey?: string,
    ): Promise<Models.ColumnUrl>;
    updateUrlColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, string?]
    ): Promise<Models.ColumnUrl> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                newKey: rest[4] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/url/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Create a varchar column.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {number} params.size - Column size for varchar columns, in number of characters. Maximum size is 16381.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} params.array - Is column an array?
     * @param {boolean} params.encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnVarchar>}
     */
    createVarcharColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        size: number;
        required: boolean;
        xdefault?: string;
        array?: boolean;
        encrypt?: boolean;
    }): Promise<Models.ColumnVarchar>;
    /**
     * Create a varchar column.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {number} size - Column size for varchar columns, in number of characters. Maximum size is 16381.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {boolean} array - Is column an array?
     * @param {boolean} encrypt - Toggle encryption for the column. Encryption enhances security by not storing any plain text values in the database. However, encrypted columns cannot be queried.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnVarchar>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createVarcharColumn(
        databaseId: string,
        tableId: string,
        key: string,
        size: number,
        required: boolean,
        xdefault?: string,
        array?: boolean,
        encrypt?: boolean,
    ): Promise<Models.ColumnVarchar>;
    createVarcharColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  size: number;
                  required: boolean;
                  xdefault?: string;
                  array?: boolean;
                  encrypt?: boolean;
              }
            | string,
        ...rest: [
            string?,
            string?,
            number?,
            boolean?,
            string?,
            boolean?,
            boolean?,
        ]
    ): Promise<Models.ColumnVarchar> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            size: number;
            required: boolean;
            xdefault?: string;
            array?: boolean;
            encrypt?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                size: number;
                required: boolean;
                xdefault?: string;
                array?: boolean;
                encrypt?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                size: rest[2] as number,
                required: rest[3] as boolean,
                xdefault: rest[4] as string,
                array: rest[5] as boolean,
                encrypt: rest[6] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const size = params.size;
        const required = params.required;
        const xdefault = params.xdefault;
        const array = params.array;
        const encrypt = params.encrypt;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof size === 'undefined') {
            throw new BunwriteException('Missing required parameter: "size"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/varchar'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof size !== 'undefined') {
            apiPayload['size'] = size;
        }
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof array !== 'undefined') {
            apiPayload['array'] = array;
        }
        if (typeof encrypt !== 'undefined') {
            apiPayload['encrypt'] = encrypt;
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
     * Update a varchar column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Column Key.
     * @param {boolean} params.required - Is column required?
     * @param {string} params.xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {number} params.size - Maximum size of the varchar column.
     * @param {string} params.newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnVarchar>}
     */
    updateVarcharColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
        required: boolean;
        xdefault?: string;
        size?: number;
        newKey?: string;
    }): Promise<Models.ColumnVarchar>;
    /**
     * Update a varchar column. Changing the `default` value will not update already existing rows.
     *
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Column Key.
     * @param {boolean} required - Is column required?
     * @param {string} xdefault - Default value for column when not provided. Cannot be set when column is required.
     * @param {number} size - Maximum size of the varchar column.
     * @param {string} newKey - New Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnVarchar>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateVarcharColumn(
        databaseId: string,
        tableId: string,
        key: string,
        required: boolean,
        xdefault?: string,
        size?: number,
        newKey?: string,
    ): Promise<Models.ColumnVarchar>;
    updateVarcharColumn(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  required: boolean;
                  xdefault?: string;
                  size?: number;
                  newKey?: string;
              }
            | string,
        ...rest: [string?, string?, boolean?, string?, number?, string?]
    ): Promise<Models.ColumnVarchar> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            required: boolean;
            xdefault?: string;
            size?: number;
            newKey?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                required: boolean;
                xdefault?: string;
                size?: number;
                newKey?: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                required: rest[2] as boolean,
                xdefault: rest[3] as string,
                size: rest[4] as number,
                newKey: rest[5] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const required = params.required;
        const xdefault = params.xdefault;
        const size = params.size;
        const newKey = params.newKey;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof required === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "required"',
            );
        }
        if (typeof xdefault === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "xdefault"',
            );
        }
        const apiPath =
            '/tablesdb/{databaseId}/tables/{tableId}/columns/varchar/{key}'
                .replace('{databaseId}', encodeURIComponent(String(databaseId)))
                .replace('{tableId}', encodeURIComponent(String(tableId)))
                .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        if (typeof required !== 'undefined') {
            apiPayload['required'] = required;
        }
        if (typeof xdefault !== 'undefined') {
            apiPayload['default'] = xdefault;
        }
        if (typeof size !== 'undefined') {
            apiPayload['size'] = size;
        }
        if (typeof newKey !== 'undefined') {
            apiPayload['newKey'] = newKey;
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
     * Get column by ID.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBoolean | Models.ColumnInteger | Models.ColumnFloat | Models.ColumnEmail | Models.ColumnEnum | Models.ColumnUrl | Models.ColumnIp | Models.ColumnDatetime | Models.ColumnRelationship | Models.ColumnString>}
     */
    getColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
    }): Promise<
        | Models.ColumnBoolean
        | Models.ColumnInteger
        | Models.ColumnFloat
        | Models.ColumnEmail
        | Models.ColumnEnum
        | Models.ColumnUrl
        | Models.ColumnIp
        | Models.ColumnDatetime
        | Models.ColumnRelationship
        | Models.ColumnString
    >;
    /**
     * Get column by ID.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnBoolean | Models.ColumnInteger | Models.ColumnFloat | Models.ColumnEmail | Models.ColumnEnum | Models.ColumnUrl | Models.ColumnIp | Models.ColumnDatetime | Models.ColumnRelationship | Models.ColumnString>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getColumn(
        databaseId: string,
        tableId: string,
        key: string,
    ): Promise<
        | Models.ColumnBoolean
        | Models.ColumnInteger
        | Models.ColumnFloat
        | Models.ColumnEmail
        | Models.ColumnEnum
        | Models.ColumnUrl
        | Models.ColumnIp
        | Models.ColumnDatetime
        | Models.ColumnRelationship
        | Models.ColumnString
    >;
    getColumn(
        paramsOrFirst:
            { databaseId: string; tableId: string; key: string } | string,
        ...rest: [string?, string?]
    ): Promise<
        | Models.ColumnBoolean
        | Models.ColumnInteger
        | Models.ColumnFloat
        | Models.ColumnEmail
        | Models.ColumnEnum
        | Models.ColumnUrl
        | Models.ColumnIp
        | Models.ColumnDatetime
        | Models.ColumnRelationship
        | Models.ColumnString
    > {
        let params: { databaseId: string; tableId: string; key: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/{key}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)))
            .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Deletes a column.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID.
     * @param {string} params.key - Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteColumn(params: {
        databaseId: string;
        tableId: string;
        key: string;
    }): Promise<{}>;
    /**
     * Deletes a column.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID.
     * @param {string} key - Column Key.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteColumn(databaseId: string, tableId: string, key: string): Promise<{}>;
    deleteColumn(
        paramsOrFirst:
            { databaseId: string; tableId: string; key: string } | string,
        ...rest: [string?, string?]
    ): Promise<{}> {
        let params: { databaseId: string; tableId: string; key: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/columns/{key}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)))
            .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }

    /**
     * List indexes on the table.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: key, type, status, attributes, error
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIndexList>}
     */
    listIndexes(params: {
        databaseId: string;
        tableId: string;
        queries?: string[];
        total?: boolean;
    }): Promise<Models.ColumnIndexList>;
    /**
     * List indexes on the table.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following columns: key, type, status, attributes, error
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIndexList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listIndexes(
        databaseId: string,
        tableId: string,
        queries?: string[],
        total?: boolean,
    ): Promise<Models.ColumnIndexList>;
    listIndexes(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  queries?: string[];
                  total?: boolean;
              }
            | string,
        ...rest: [string?, string[]?, boolean?]
    ): Promise<Models.ColumnIndexList> {
        let params: {
            databaseId: string;
            tableId: string;
            queries?: string[];
            total?: boolean;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                queries?: string[];
                total?: boolean;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                queries: rest[1] as string[],
                total: rest[2] as boolean,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const queries = params.queries;
        const total = params.total;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/indexes'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof queries !== 'undefined') {
            apiPayload['queries'] = queries;
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
     * Creates an index on the columns listed. Your index should include all the columns you will query in a single request.
     * Type can be `key`, `fulltext`, or `unique`.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Index Key.
     * @param {TablesDBIndexType} params.type - Index type.
     * @param {string[]} params.columns - Array of columns to index. Maximum of 100 columns are allowed, each 32 characters long.
     * @param {OrderBy[]} params.orders - Array of index orders. Maximum of 100 orders are allowed.
     * @param {number[]} params.lengths - Length of index. Maximum of 100
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIndex>}
     */
    createIndex(params: {
        databaseId: string;
        tableId: string;
        key: string;
        type: TablesDBIndexType;
        columns: string[];
        orders?: OrderBy[];
        lengths?: number[];
    }): Promise<Models.ColumnIndex>;
    /**
     * Creates an index on the columns listed. Your index should include all the columns you will query in a single request.
     * Type can be `key`, `fulltext`, or `unique`.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Index Key.
     * @param {TablesDBIndexType} type - Index type.
     * @param {string[]} columns - Array of columns to index. Maximum of 100 columns are allowed, each 32 characters long.
     * @param {OrderBy[]} orders - Array of index orders. Maximum of 100 orders are allowed.
     * @param {number[]} lengths - Length of index. Maximum of 100
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIndex>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createIndex(
        databaseId: string,
        tableId: string,
        key: string,
        type: TablesDBIndexType,
        columns: string[],
        orders?: OrderBy[],
        lengths?: number[],
    ): Promise<Models.ColumnIndex>;
    createIndex(
        paramsOrFirst:
            | {
                  databaseId: string;
                  tableId: string;
                  key: string;
                  type: TablesDBIndexType;
                  columns: string[];
                  orders?: OrderBy[];
                  lengths?: number[];
              }
            | string,
        ...rest: [
            string?,
            string?,
            TablesDBIndexType?,
            string[]?,
            OrderBy[]?,
            number[]?,
        ]
    ): Promise<Models.ColumnIndex> {
        let params: {
            databaseId: string;
            tableId: string;
            key: string;
            type: TablesDBIndexType;
            columns: string[];
            orders?: OrderBy[];
            lengths?: number[];
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
                type: TablesDBIndexType;
                columns: string[];
                orders?: OrderBy[];
                lengths?: number[];
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
                type: rest[2] as TablesDBIndexType,
                columns: rest[3] as string[],
                orders: rest[4] as OrderBy[],
                lengths: rest[5] as number[],
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        const type = params.type;
        const columns = params.columns;
        const orders = params.orders;
        const lengths = params.lengths;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        if (typeof type === 'undefined') {
            throw new BunwriteException('Missing required parameter: "type"');
        }
        if (typeof columns === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "columns"',
            );
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/indexes'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)));
        const apiPayload: Payload = {};
        if (typeof key !== 'undefined') {
            apiPayload['key'] = key;
        }
        if (typeof type !== 'undefined') {
            apiPayload['type'] = type;
        }
        if (typeof columns !== 'undefined') {
            apiPayload['columns'] = columns;
        }
        if (typeof orders !== 'undefined') {
            apiPayload['orders'] = orders;
        }
        if (typeof lengths !== 'undefined') {
            apiPayload['lengths'] = lengths;
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
     * Get index by ID.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Index Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIndex>}
     */
    getIndex(params: {
        databaseId: string;
        tableId: string;
        key: string;
    }): Promise<Models.ColumnIndex>;
    /**
     * Get index by ID.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the Database service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Index Key.
     * @throws {BunwriteException}
     * @returns {Promise<Models.ColumnIndex>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getIndex(
        databaseId: string,
        tableId: string,
        key: string,
    ): Promise<Models.ColumnIndex>;
    getIndex(
        paramsOrFirst:
            { databaseId: string; tableId: string; key: string } | string,
        ...rest: [string?, string?]
    ): Promise<Models.ColumnIndex> {
        let params: { databaseId: string; tableId: string; key: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/indexes/{key}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)))
            .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete an index.
     *
     * @param {string} params.databaseId - Database ID.
     * @param {string} params.tableId - Table ID. You can create a new table using the TablesDB service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} params.key - Index Key.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteIndex(params: {
        databaseId: string;
        tableId: string;
        key: string;
    }): Promise<{}>;
    /**
     * Delete an index.
     *
     * @param {string} databaseId - Database ID.
     * @param {string} tableId - Table ID. You can create a new table using the TablesDB service [server integration](https://appwrite.io/docs/references/cloud/server-dart/tablesDB#createTable).
     * @param {string} key - Index Key.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteIndex(databaseId: string, tableId: string, key: string): Promise<{}>;
    deleteIndex(
        paramsOrFirst:
            { databaseId: string; tableId: string; key: string } | string,
        ...rest: [string?, string?]
    ): Promise<{}> {
        let params: { databaseId: string; tableId: string; key: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                databaseId: string;
                tableId: string;
                key: string;
            };
        } else {
            params = {
                databaseId: paramsOrFirst as string,
                tableId: rest[0] as string,
                key: rest[1] as string,
            };
        }

        const databaseId = params.databaseId;
        const tableId = params.tableId;
        const key = params.key;
        if (typeof databaseId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "databaseId"',
            );
        }
        if (typeof tableId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "tableId"',
            );
        }
        if (typeof key === 'undefined') {
            throw new BunwriteException('Missing required parameter: "key"');
        }
        const apiPath = '/tablesdb/{databaseId}/tables/{tableId}/indexes/{key}'
            .replace('{databaseId}', encodeURIComponent(String(databaseId)))
            .replace('{tableId}', encodeURIComponent(String(tableId)))
            .replace('{key}', encodeURIComponent(String(key)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }
}
