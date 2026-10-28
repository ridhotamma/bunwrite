// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

export class Users {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a list of all the project's users. You can use the query params to filter your results.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, email, phone, status, passwordUpdate, registration, emailVerification, phoneVerification, labels, impersonator, accessedAt
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.UserList<Preferences>>}
     */
    list<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params?: {
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.UserList<Preferences>>;
    /**
     * Get a list of all the project's users. You can use the query params to filter your results.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, email, phone, status, passwordUpdate, registration, emailVerification, phoneVerification, labels, impersonator, accessedAt
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.UserList<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    list<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.UserList<Preferences>>;
    list<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        paramsOrFirst?:
            { queries?: string[]; search?: string; total?: boolean } | string[],
        ...rest: [string?, boolean?]
    ): Promise<Models.UserList<Preferences>> {
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
        const apiPath = '/users';
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
     * Create a new user.
     *
     * @param {string} params.userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.email - User email.
     * @param {string} params.phone - Phone number. Format this number with a leading '+' and a country code, e.g., +16175551212.
     * @param {string} params.password - Plain text user password. Must be at least 8 chars.
     * @param {string} params.name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    create<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        email?: string;
        phone?: string;
        password?: string;
        name?: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Create a new user.
     *
     * @param {string} userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} email - User email.
     * @param {string} phone - Phone number. Format this number with a leading '+' and a country code, e.g., +16175551212.
     * @param {string} password - Plain text user password. Must be at least 8 chars.
     * @param {string} name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    create<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        userId: string,
        email?: string,
        phone?: string,
        password?: string,
        name?: string,
    ): Promise<Models.User<Preferences>>;
    create<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        paramsOrFirst:
            | {
                  userId: string;
                  email?: string;
                  phone?: string;
                  password?: string;
                  name?: string;
              }
            | string,
        ...rest: [string?, string?, string?, string?]
    ): Promise<Models.User<Preferences>> {
        let params: {
            userId: string;
            email?: string;
            phone?: string;
            password?: string;
            name?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                email?: string;
                phone?: string;
                password?: string;
                name?: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                email: rest[0] as string,
                phone: rest[1] as string,
                password: rest[2] as string,
                name: rest[3] as string,
            };
        }

        const userId = params.userId;
        const email = params.email;
        const phone = params.phone;
        const password = params.password;
        const name = params.name;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
        }
        if (typeof phone !== 'undefined') {
            apiPayload['phone'] = phone;
        }
        if (typeof password !== 'undefined') {
            apiPayload['password'] = password;
        }
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
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
     * Get identities for all users.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: userId, provider, providerUid, providerEmail, providerAccessTokenExpiry
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.IdentityList>}
     */
    listIdentities(params?: {
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.IdentityList>;
    /**
     * Get identities for all users.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: userId, provider, providerUid, providerEmail, providerAccessTokenExpiry
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.IdentityList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listIdentities(
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.IdentityList>;
    listIdentities(
        paramsOrFirst?:
            { queries?: string[]; search?: string; total?: boolean } | string[],
        ...rest: [string?, boolean?]
    ): Promise<Models.IdentityList> {
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
        const apiPath = '/users/identities';
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
     * Get a user by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    get<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: { userId: string }): Promise<Models.User<Preferences>>;
    /**
     * Get a user by its unique ID.
     *
     * @param {string} userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    get<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        userId: string,
    ): Promise<Models.User<Preferences>>;
    get<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        paramsOrFirst: { userId: string } | string,
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
            };
        }

        const userId = params.userId;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
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
     * Delete a user by its unique ID, thereby releasing it's ID. Since ID is released and can be reused, all user-related resources like documents or storage files should be deleted before user deletion. If you want to keep ID reserved, use the [updateStatus](https://appwrite.io/docs/server/users#usersUpdateStatus) endpoint instead.
     *
     * @param {string} params.userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    delete(params: { userId: string }): Promise<{}>;
    /**
     * Delete a user by its unique ID, thereby releasing it's ID. Since ID is released and can be reused, all user-related resources like documents or storage files should be deleted before user deletion. If you want to keep ID reserved, use the [updateStatus](https://appwrite.io/docs/server/users#usersUpdateStatus) endpoint instead.
     *
     * @param {string} userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    delete(userId: string): Promise<{}>;
    delete(paramsOrFirst: { userId: string } | string): Promise<{}> {
        let params: { userId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
            };
        }

        const userId = params.userId;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
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
     * Update the user email by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.email - User email.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateEmail<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        email: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user email by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {string} email - User email.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEmail<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, email: string): Promise<Models.User<Preferences>>;
    updateEmail<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; email: string } | string,
        ...rest: [string?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; email: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string; email: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
                email: rest[0] as string,
            };
        }

        const userId = params.userId;
        const email = params.email;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof email === 'undefined') {
            throw new BunwriteException('Missing required parameter: "email"');
        }
        const apiPath = '/users/{userId}/email'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
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
     * Use this endpoint to create a JSON Web Token for user by its unique ID. You can use the resulting JWT to authenticate on behalf of the user. The JWT secret will become invalid if the session it uses gets deleted.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.sessionId - Session ID. Use the string 'recent()' to use the most recent session, which is also the default.
     * @param {number} params.duration - Time in seconds before JWT expires. Default duration is 900 seconds, and maximum is 3600 seconds.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Jwt>}
     */
    createJWT(params: {
        userId: string;
        sessionId?: string;
        duration?: number;
    }): Promise<Models.Jwt>;
    /**
     * Use this endpoint to create a JSON Web Token for user by its unique ID. You can use the resulting JWT to authenticate on behalf of the user. The JWT secret will become invalid if the session it uses gets deleted.
     *
     * @param {string} userId - User ID.
     * @param {string} sessionId - Session ID. Use the string 'recent()' to use the most recent session, which is also the default.
     * @param {number} duration - Time in seconds before JWT expires. Default duration is 900 seconds, and maximum is 3600 seconds.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Jwt>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createJWT(
        userId: string,
        sessionId?: string,
        duration?: number,
    ): Promise<Models.Jwt>;
    createJWT(
        paramsOrFirst:
            { userId: string; sessionId?: string; duration?: number } | string,
        ...rest: [string?, number?]
    ): Promise<Models.Jwt> {
        let params: { userId: string; sessionId?: string; duration?: number };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                sessionId?: string;
                duration?: number;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                sessionId: rest[0] as string,
                duration: rest[1] as number,
            };
        }

        const userId = params.userId;
        const sessionId = params.sessionId;
        const duration = params.duration;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/jwts'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof sessionId !== 'undefined') {
            apiPayload['sessionId'] = sessionId;
        }
        if (typeof duration !== 'undefined') {
            apiPayload['duration'] = duration;
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
     * Update the user labels by its unique ID.
     *
     * Labels can be used to grant access to resources. While teams are a way for user's to share access to a resource, labels can be defined by the developer to grant access without an invitation. See the [Permissions docs](https://appwrite.io/docs/permissions) for more info.
     *
     * @param {string} params.userId - User ID.
     * @param {string[]} params.labels - Array of user labels. Replaces the previous labels. Maximum of 1000 labels are allowed, each up to 36 alphanumeric characters long.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateLabels<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        labels: string[];
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user labels by its unique ID.
     *
     * Labels can be used to grant access to resources. While teams are a way for user's to share access to a resource, labels can be defined by the developer to grant access without an invitation. See the [Permissions docs](https://appwrite.io/docs/permissions) for more info.
     *
     * @param {string} userId - User ID.
     * @param {string[]} labels - Array of user labels. Replaces the previous labels. Maximum of 1000 labels are allowed, each up to 36 alphanumeric characters long.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateLabels<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, labels: string[]): Promise<Models.User<Preferences>>;
    updateLabels<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; labels: string[] } | string,
        ...rest: [string[]?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; labels: string[] };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                labels: string[];
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                labels: rest[0] as string[],
            };
        }

        const userId = params.userId;
        const labels = params.labels;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof labels === 'undefined') {
            throw new BunwriteException('Missing required parameter: "labels"');
        }
        const apiPath = '/users/{userId}/labels'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof labels !== 'undefined') {
            apiPayload['labels'] = labels;
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
     * Get the user membership list by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: userId, teamId, invited, joined, confirm, roles
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MembershipList>}
     */
    listMemberships(params: {
        userId: string;
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.MembershipList>;
    /**
     * Get the user membership list by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: userId, teamId, invited, joined, confirm, roles
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MembershipList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listMemberships(
        userId: string,
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.MembershipList>;
    listMemberships(
        paramsOrFirst:
            | {
                  userId: string;
                  queries?: string[];
                  search?: string;
                  total?: boolean;
              }
            | string,
        ...rest: [string[]?, string?, boolean?]
    ): Promise<Models.MembershipList> {
        let params: {
            userId: string;
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
                userId: string;
                queries?: string[];
                search?: string;
                total?: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                queries: rest[0] as string[],
                search: rest[1] as string,
                total: rest[2] as boolean,
            };
        }

        const userId = params.userId;
        const queries = params.queries;
        const search = params.search;
        const total = params.total;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/memberships'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
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
     * Update the user name by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateName<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        name: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user name by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {string} name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateName<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, name: string): Promise<Models.User<Preferences>>;
    updateName<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; name: string } | string,
        ...rest: [string?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; name: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string; name: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
                name: rest[0] as string,
            };
        }

        const userId = params.userId;
        const name = params.name;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/users/{userId}/name'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
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
     * Update the user password by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.password - New user password. Must be at least 8 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updatePassword<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        password: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user password by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {string} password - New user password. Must be at least 8 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePassword<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, password: string): Promise<Models.User<Preferences>>;
    updatePassword<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; password: string } | string,
        ...rest: [string?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; password: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                password: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                password: rest[0] as string,
            };
        }

        const userId = params.userId;
        const password = params.password;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof password === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "password"',
            );
        }
        const apiPath = '/users/{userId}/password'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof password !== 'undefined') {
            apiPayload['password'] = password;
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
     * Update the user phone by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.number - User phone number.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updatePhone<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        number: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user phone by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {string} number - User phone number.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePhone<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, number: string): Promise<Models.User<Preferences>>;
    updatePhone<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; number: string } | string,
        ...rest: [string?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; number: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                number: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                number: rest[0] as string,
            };
        }

        const userId = params.userId;
        const number = params.number;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof number === 'undefined') {
            throw new BunwriteException('Missing required parameter: "number"');
        }
        const apiPath = '/users/{userId}/phone'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof number !== 'undefined') {
            apiPayload['number'] = number;
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
     * Get the user preferences by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<Preferences>}
     */
    getPrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: { userId: string }): Promise<Preferences>;
    /**
     * Get the user preferences by its unique ID.
     *
     * @param {string} userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<Preferences>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getPrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string): Promise<Preferences>;
    getPrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(paramsOrFirst: { userId: string } | string): Promise<Preferences> {
        let params: { userId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
            };
        }

        const userId = params.userId;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/prefs'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
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
     * Update the user preferences by its unique ID. The object you pass is stored as is, and replaces any previous value. The maximum allowed prefs size is 64kB and throws error if exceeded.
     *
     * @param {string} params.userId - User ID.
     * @param {object} params.prefs - Prefs key-value JSON object.
     * @throws {BunwriteException}
     * @returns {Promise<Preferences>}
     */
    updatePrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: { userId: string; prefs: object }): Promise<Preferences>;
    /**
     * Update the user preferences by its unique ID. The object you pass is stored as is, and replaces any previous value. The maximum allowed prefs size is 64kB and throws error if exceeded.
     *
     * @param {string} userId - User ID.
     * @param {object} prefs - Prefs key-value JSON object.
     * @throws {BunwriteException}
     * @returns {Promise<Preferences>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, prefs: object): Promise<Preferences>;
    updatePrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; prefs: object } | string,
        ...rest: [object?]
    ): Promise<Preferences> {
        let params: { userId: string; prefs: object };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string; prefs: object };
        } else {
            params = {
                userId: paramsOrFirst as string,
                prefs: rest[0] as object,
            };
        }

        const userId = params.userId;
        const prefs = params.prefs;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof prefs === 'undefined') {
            throw new BunwriteException('Missing required parameter: "prefs"');
        }
        const apiPath = '/users/{userId}/prefs'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof prefs !== 'undefined') {
            apiPayload['prefs'] = prefs;
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
     * Get the user sessions list by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.SessionList>}
     */
    listSessions(params: {
        userId: string;
        total?: boolean;
    }): Promise<Models.SessionList>;
    /**
     * Get the user sessions list by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.SessionList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listSessions(userId: string, total?: boolean): Promise<Models.SessionList>;
    listSessions(
        paramsOrFirst: { userId: string; total?: boolean } | string,
        ...rest: [boolean?]
    ): Promise<Models.SessionList> {
        let params: { userId: string; total?: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                total?: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                total: rest[0] as boolean,
            };
        }

        const userId = params.userId;
        const total = params.total;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/sessions'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
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
     * Creates a session for a user. Returns an immediately usable session object.
     *
     * If you want to generate a token for a custom authentication flow, use the [POST /users/{userId}/tokens](https://appwrite.io/docs/server/users#createToken) endpoint.
     *
     * @param {string} params.userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     */
    createSession(params: { userId: string }): Promise<Models.Session>;
    /**
     * Creates a session for a user. Returns an immediately usable session object.
     *
     * If you want to generate a token for a custom authentication flow, use the [POST /users/{userId}/tokens](https://appwrite.io/docs/server/users#createToken) endpoint.
     *
     * @param {string} userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createSession(userId: string): Promise<Models.Session>;
    createSession(
        paramsOrFirst: { userId: string } | string,
    ): Promise<Models.Session> {
        let params: { userId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
            };
        }

        const userId = params.userId;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/sessions'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('post', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete all user's sessions by using the user's unique ID.
     *
     * @param {string} params.userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteSessions(params: { userId: string }): Promise<{}>;
    /**
     * Delete all user's sessions by using the user's unique ID.
     *
     * @param {string} userId - User ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteSessions(userId: string): Promise<{}>;
    deleteSessions(paramsOrFirst: { userId: string } | string): Promise<{}> {
        let params: { userId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { userId: string };
        } else {
            params = {
                userId: paramsOrFirst as string,
            };
        }

        const userId = params.userId;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/sessions'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
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
     * Delete a user sessions by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.sessionId - Session ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteSession(params: { userId: string; sessionId: string }): Promise<{}>;
    /**
     * Delete a user sessions by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {string} sessionId - Session ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteSession(userId: string, sessionId: string): Promise<{}>;
    deleteSession(
        paramsOrFirst: { userId: string; sessionId: string } | string,
        ...rest: [string?]
    ): Promise<{}> {
        let params: { userId: string; sessionId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                sessionId: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                sessionId: rest[0] as string,
            };
        }

        const userId = params.userId;
        const sessionId = params.sessionId;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof sessionId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "sessionId"',
            );
        }
        const apiPath = '/users/{userId}/sessions/{sessionId}'
            .replace('{userId}', encodeURIComponent(String(userId)))
            .replace('{sessionId}', encodeURIComponent(String(sessionId)));
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }

    /**
     * Update the user status by its unique ID. Use this endpoint as an alternative to deleting a user if you want to keep user's ID reserved.
     *
     * @param {string} params.userId - User ID.
     * @param {boolean} params.status - User Status. To activate the user pass `true` and to block the user pass `false`.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateStatus<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        status: boolean;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user status by its unique ID. Use this endpoint as an alternative to deleting a user if you want to keep user's ID reserved.
     *
     * @param {string} userId - User ID.
     * @param {boolean} status - User Status. To activate the user pass `true` and to block the user pass `false`.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateStatus<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(userId: string, status: boolean): Promise<Models.User<Preferences>>;
    updateStatus<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; status: boolean } | string,
        ...rest: [boolean?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; status: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                status: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                status: rest[0] as boolean,
            };
        }

        const userId = params.userId;
        const status = params.status;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof status === 'undefined') {
            throw new BunwriteException('Missing required parameter: "status"');
        }
        const apiPath = '/users/{userId}/status'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof status !== 'undefined') {
            apiPayload['status'] = status;
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
     * Returns a token with a secret key for creating a session. Use the user ID and secret and submit a request to the [PUT /account/sessions/token](https://appwrite.io/docs/references/cloud/client-web/account#createSession) endpoint to complete the login process.
     *
     *
     * @param {string} params.userId - User ID.
     * @param {number} params.length - Token length in characters. The default length is 6 characters
     * @param {number} params.expire - Token expiration period in seconds. The default expiration is 15 minutes.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     */
    createToken(params: {
        userId: string;
        length?: number;
        expire?: number;
    }): Promise<Models.Token>;
    /**
     * Returns a token with a secret key for creating a session. Use the user ID and secret and submit a request to the [PUT /account/sessions/token](https://appwrite.io/docs/references/cloud/client-web/account#createSession) endpoint to complete the login process.
     *
     *
     * @param {string} userId - User ID.
     * @param {number} length - Token length in characters. The default length is 6 characters
     * @param {number} expire - Token expiration period in seconds. The default expiration is 15 minutes.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createToken(
        userId: string,
        length?: number,
        expire?: number,
    ): Promise<Models.Token>;
    createToken(
        paramsOrFirst:
            { userId: string; length?: number; expire?: number } | string,
        ...rest: [number?, number?]
    ): Promise<Models.Token> {
        let params: { userId: string; length?: number; expire?: number };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                length?: number;
                expire?: number;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                length: rest[0] as number,
                expire: rest[1] as number,
            };
        }

        const userId = params.userId;
        const length = params.length;
        const expire = params.expire;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        const apiPath = '/users/{userId}/tokens'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof length !== 'undefined') {
            apiPayload['length'] = length;
        }
        if (typeof expire !== 'undefined') {
            apiPayload['expire'] = expire;
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
     * Update the user email verification status by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {boolean} params.emailVerification - User email verification status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateEmailVerification<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        emailVerification: boolean;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user email verification status by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {boolean} emailVerification - User email verification status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEmailVerification<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        userId: string,
        emailVerification: boolean,
    ): Promise<Models.User<Preferences>>;
    updateEmailVerification<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; emailVerification: boolean } | string,
        ...rest: [boolean?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; emailVerification: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                emailVerification: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                emailVerification: rest[0] as boolean,
            };
        }

        const userId = params.userId;
        const emailVerification = params.emailVerification;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof emailVerification === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "emailVerification"',
            );
        }
        const apiPath = '/users/{userId}/verification'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof emailVerification !== 'undefined') {
            apiPayload['emailVerification'] = emailVerification;
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
     * Update the user phone verification status by its unique ID.
     *
     * @param {string} params.userId - User ID.
     * @param {boolean} params.phoneVerification - User phone verification status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updatePhoneVerification<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        phoneVerification: boolean;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update the user phone verification status by its unique ID.
     *
     * @param {string} userId - User ID.
     * @param {boolean} phoneVerification - User phone verification status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePhoneVerification<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        userId: string,
        phoneVerification: boolean,
    ): Promise<Models.User<Preferences>>;
    updatePhoneVerification<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { userId: string; phoneVerification: boolean } | string,
        ...rest: [boolean?]
    ): Promise<Models.User<Preferences>> {
        let params: { userId: string; phoneVerification: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                phoneVerification: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                phoneVerification: rest[0] as boolean,
            };
        }

        const userId = params.userId;
        const phoneVerification = params.phoneVerification;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof phoneVerification === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "phoneVerification"',
            );
        }
        const apiPath = '/users/{userId}/verification/phone'.replace(
            '{userId}',
            encodeURIComponent(String(userId)),
        );
        const apiPayload: Payload = {};
        if (typeof phoneVerification !== 'undefined') {
            apiPayload['phoneVerification'] = phoneVerification;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('patch', uri, apiHeaders, apiPayload);
    }
}
