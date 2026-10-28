// Copied from node-appwrite 29.0.0 and appwrite 27.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

import { OAuthProvider } from '../enums/o-auth-provider';
// Only set in browsers.
declare const window: any;

export class Account {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get the currently logged in user.
     *
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    get<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(): Promise<Models.User<Preferences>> {
        const apiPath = '/account';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Use this endpoint to allow a new user to register a new account in your project. After the user registration completes successfully, you can use the [/account/verfication](https://appwrite.io/docs/references/cloud/client-web/account#createVerification) route to start verifying the user email address. To allow the new user to login to their new account, you need to create a new [account session](https://appwrite.io/docs/references/cloud/client-web/account#createEmailSession).
     *
     * @param {string} params.userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.email - User email.
     * @param {string} params.password - New user password. Must be between 8 and 256 chars.
     * @param {string} params.name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    create<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        userId: string;
        email: string;
        password: string;
        name?: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Use this endpoint to allow a new user to register a new account in your project. After the user registration completes successfully, you can use the [/account/verfication](https://appwrite.io/docs/references/cloud/client-web/account#createVerification) route to start verifying the user email address. To allow the new user to login to their new account, you need to create a new [account session](https://appwrite.io/docs/references/cloud/client-web/account#createEmailSession).
     *
     * @param {string} userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} email - User email.
     * @param {string} password - New user password. Must be between 8 and 256 chars.
     * @param {string} name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    create<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        userId: string,
        email: string,
        password: string,
        name?: string,
    ): Promise<Models.User<Preferences>>;
    create<Preferences extends Models.Preferences = Models.DefaultPreferences>(
        paramsOrFirst:
            | { userId: string; email: string; password: string; name?: string }
            | string,
        ...rest: [string?, string?, string?]
    ): Promise<Models.User<Preferences>> {
        let params: {
            userId: string;
            email: string;
            password: string;
            name?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                email: string;
                password: string;
                name?: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                email: rest[0] as string,
                password: rest[1] as string,
                name: rest[2] as string,
            };
        }

        const userId = params.userId;
        const email = params.email;
        const password = params.password;
        const name = params.name;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof email === 'undefined') {
            throw new BunwriteException('Missing required parameter: "email"');
        }
        if (typeof password === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "password"',
            );
        }
        const apiPath = '/account';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
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
     * Update currently logged in user account email address. After changing user address, the user confirmation status will get reset. A new confirmation email is not sent automatically however you can use the send confirmation email endpoint again to send the confirmation email. For security measures, user password is required to complete this request.
     * This endpoint can also be used to convert an anonymous account to a normal one, by passing an email address and a new password.
     *
     *
     * @param {string} params.email - User email.
     * @param {string} params.password - User password. Must be at least 8 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateEmail<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        email: string;
        password: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update currently logged in user account email address. After changing user address, the user confirmation status will get reset. A new confirmation email is not sent automatically however you can use the send confirmation email endpoint again to send the confirmation email. For security measures, user password is required to complete this request.
     * This endpoint can also be used to convert an anonymous account to a normal one, by passing an email address and a new password.
     *
     *
     * @param {string} email - User email.
     * @param {string} password - User password. Must be at least 8 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEmail<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(email: string, password: string): Promise<Models.User<Preferences>>;
    updateEmail<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { email: string; password: string } | string,
        ...rest: [string?]
    ): Promise<Models.User<Preferences>> {
        let params: { email: string; password: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                email: string;
                password: string;
            };
        } else {
            params = {
                email: paramsOrFirst as string,
                password: rest[0] as string,
            };
        }

        const email = params.email;
        const password = params.password;
        if (typeof email === 'undefined') {
            throw new BunwriteException('Missing required parameter: "email"');
        }
        if (typeof password === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "password"',
            );
        }
        const apiPath = '/account/email';
        const apiPayload: Payload = {};
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
        }
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
     * Update currently logged in user account name.
     *
     * @param {string} params.name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateName<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: { name: string }): Promise<Models.User<Preferences>>;
    /**
     * Update currently logged in user account name.
     *
     * @param {string} name - User name. Max length: 128 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateName<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(name: string): Promise<Models.User<Preferences>>;
    updateName<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { name: string } | string,
    ): Promise<Models.User<Preferences>> {
        let params: { name: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { name: string };
        } else {
            params = {
                name: paramsOrFirst as string,
            };
        }

        const name = params.name;
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        const apiPath = '/account/name';
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
     * Update currently logged in user password. For validation, user is required to pass in the new password, and the old password. For users created with OAuth, Team Invites and Magic URL, oldPassword is optional.
     *
     * @param {string} params.password - New user password. Must be at least 8 chars.
     * @param {string} params.oldPassword - Current user password. Max length: 256 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updatePassword<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        password: string;
        oldPassword?: string;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update currently logged in user password. For validation, user is required to pass in the new password, and the old password. For users created with OAuth, Team Invites and Magic URL, oldPassword is optional.
     *
     * @param {string} password - New user password. Must be at least 8 chars.
     * @param {string} oldPassword - Current user password. Max length: 256 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePassword<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        password: string,
        oldPassword?: string,
    ): Promise<Models.User<Preferences>>;
    updatePassword<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { password: string; oldPassword?: string } | string,
        ...rest: [string?]
    ): Promise<Models.User<Preferences>> {
        let params: { password: string; oldPassword?: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                password: string;
                oldPassword?: string;
            };
        } else {
            params = {
                password: paramsOrFirst as string,
                oldPassword: rest[0] as string,
            };
        }

        const password = params.password;
        const oldPassword = params.oldPassword;
        if (typeof password === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "password"',
            );
        }
        const apiPath = '/account/password';
        const apiPayload: Payload = {};
        if (typeof password !== 'undefined') {
            apiPayload['password'] = password;
        }
        if (typeof oldPassword !== 'undefined') {
            apiPayload['oldPassword'] = oldPassword;
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
     * Get the preferences as a key-value object for the currently logged in user.
     *
     * @throws {BunwriteException}
     * @returns {Promise<Preferences>}
     */
    getPrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(): Promise<Preferences> {
        const apiPath = '/account/prefs';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Update currently logged in user account preferences. The object you pass is stored as is, and replaces any previous value. The maximum allowed prefs size is 64kB and throws error if exceeded.
     *
     * @param {Partial<Preferences>} params.prefs - Prefs key-value JSON object.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updatePrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(params: {
        prefs: Partial<Preferences>;
    }): Promise<Models.User<Preferences>>;
    /**
     * Update currently logged in user account preferences. The object you pass is stored as is, and replaces any previous value. The maximum allowed prefs size is 64kB and throws error if exceeded.
     *
     * @param {Partial<Preferences>} prefs - Prefs key-value JSON object.
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(prefs: Partial<Preferences>): Promise<Models.User<Preferences>>;
    updatePrefs<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(
        paramsOrFirst: { prefs: Partial<Preferences> } | Partial<Preferences>,
    ): Promise<Models.User<Preferences>> {
        let params: { prefs: Partial<Preferences> };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            'prefs' in paramsOrFirst
        ) {
            params = (paramsOrFirst || {}) as { prefs: Partial<Preferences> };
        } else {
            params = {
                prefs: paramsOrFirst as Partial<Preferences>,
            };
        }

        const prefs = params.prefs;
        if (typeof prefs === 'undefined') {
            throw new BunwriteException('Missing required parameter: "prefs"');
        }
        const apiPath = '/account/prefs';
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
     * Sends the user an email with a temporary secret key for password reset. When the user clicks the confirmation link he is redirected back to your app password reset URL with the secret key and email address values attached to the URL query string. Use the query string params to submit a request to the [PUT /account/recovery](https://appwrite.io/docs/references/cloud/client-web/account#updateRecovery) endpoint to complete the process. The verification link sent to the user's email address is valid for 1 hour.
     *
     * @param {string} params.email - User email.
     * @param {string} params.url - URL to redirect the user back to your app from the recovery email. Only URLs from hostnames in your project platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     */
    createRecovery(params: {
        email: string;
        url: string;
    }): Promise<Models.Token>;
    /**
     * Sends the user an email with a temporary secret key for password reset. When the user clicks the confirmation link he is redirected back to your app password reset URL with the secret key and email address values attached to the URL query string. Use the query string params to submit a request to the [PUT /account/recovery](https://appwrite.io/docs/references/cloud/client-web/account#updateRecovery) endpoint to complete the process. The verification link sent to the user's email address is valid for 1 hour.
     *
     * @param {string} email - User email.
     * @param {string} url - URL to redirect the user back to your app from the recovery email. Only URLs from hostnames in your project platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createRecovery(email: string, url: string): Promise<Models.Token>;
    createRecovery(
        paramsOrFirst: { email: string; url: string } | string,
        ...rest: [string?]
    ): Promise<Models.Token> {
        let params: { email: string; url: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { email: string; url: string };
        } else {
            params = {
                email: paramsOrFirst as string,
                url: rest[0] as string,
            };
        }

        const email = params.email;
        const url = params.url;
        if (typeof email === 'undefined') {
            throw new BunwriteException('Missing required parameter: "email"');
        }
        if (typeof url === 'undefined') {
            throw new BunwriteException('Missing required parameter: "url"');
        }
        const apiPath = '/account/recovery';
        const apiPayload: Payload = {};
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
        }
        if (typeof url !== 'undefined') {
            apiPayload['url'] = url;
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
     * Use this endpoint to complete the user account password reset. Both the **userId** and **secret** arguments will be passed as query parameters to the redirect URL you have provided when sending your request to the [POST /account/recovery](https://appwrite.io/docs/references/cloud/client-web/account#createRecovery) endpoint.
     *
     * Please note that in order to avoid a [Redirect Attack](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md) the only valid redirect URLs are the ones from domains you have set when adding your platforms in the console interface.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.secret - Valid reset token.
     * @param {string} params.password - New user password. Must be between 8 and 256 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     */
    updateRecovery(params: {
        userId: string;
        secret: string;
        password: string;
    }): Promise<Models.Token>;
    /**
     * Use this endpoint to complete the user account password reset. Both the **userId** and **secret** arguments will be passed as query parameters to the redirect URL you have provided when sending your request to the [POST /account/recovery](https://appwrite.io/docs/references/cloud/client-web/account#createRecovery) endpoint.
     *
     * Please note that in order to avoid a [Redirect Attack](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md) the only valid redirect URLs are the ones from domains you have set when adding your platforms in the console interface.
     *
     * @param {string} userId - User ID.
     * @param {string} secret - Valid reset token.
     * @param {string} password - New user password. Must be between 8 and 256 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateRecovery(
        userId: string,
        secret: string,
        password: string,
    ): Promise<Models.Token>;
    updateRecovery(
        paramsOrFirst:
            { userId: string; secret: string; password: string } | string,
        ...rest: [string?, string?]
    ): Promise<Models.Token> {
        let params: { userId: string; secret: string; password: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                secret: string;
                password: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                secret: rest[0] as string,
                password: rest[1] as string,
            };
        }

        const userId = params.userId;
        const secret = params.secret;
        const password = params.password;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof secret === 'undefined') {
            throw new BunwriteException('Missing required parameter: "secret"');
        }
        if (typeof password === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "password"',
            );
        }
        const apiPath = '/account/recovery';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof secret !== 'undefined') {
            apiPayload['secret'] = secret;
        }
        if (typeof password !== 'undefined') {
            apiPayload['password'] = password;
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
     * Get the list of active sessions across different devices for the currently logged in user.
     *
     * @throws {BunwriteException}
     * @returns {Promise<Models.SessionList>}
     */
    listSessions(): Promise<Models.SessionList> {
        const apiPath = '/account/sessions';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete all sessions from the user account and remove any sessions cookies from the end client.
     *
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteSessions(): Promise<{}> {
        const apiPath = '/account/sessions';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
        };

        return this.client.call('delete', uri, apiHeaders, apiPayload);
    }

    /**
     * Allow the user to login into their account by providing a valid email and password combination. This route will create a new session for the user.
     *
     * A user is limited to 10 active sessions at a time by default. [Learn more about session limits](https://appwrite.io/docs/authentication-security#limits).
     *
     * @param {string} params.email - User email.
     * @param {string} params.password - User password. Must be at least 8 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     */
    createEmailPasswordSession(params: {
        email: string;
        password: string;
    }): Promise<Models.Session>;
    /**
     * Allow the user to login into their account by providing a valid email and password combination. This route will create a new session for the user.
     *
     * A user is limited to 10 active sessions at a time by default. [Learn more about session limits](https://appwrite.io/docs/authentication-security#limits).
     *
     * @param {string} email - User email.
     * @param {string} password - User password. Must be at least 8 chars.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createEmailPasswordSession(
        email: string,
        password: string,
    ): Promise<Models.Session>;
    createEmailPasswordSession(
        paramsOrFirst: { email: string; password: string } | string,
        ...rest: [string?]
    ): Promise<Models.Session> {
        let params: { email: string; password: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                email: string;
                password: string;
            };
        } else {
            params = {
                email: paramsOrFirst as string,
                password: rest[0] as string,
            };
        }

        const email = params.email;
        const password = params.password;
        if (typeof email === 'undefined') {
            throw new BunwriteException('Missing required parameter: "email"');
        }
        if (typeof password === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "password"',
            );
        }
        const apiPath = '/account/sessions/email';
        const apiPayload: Payload = {};
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
        }
        if (typeof password !== 'undefined') {
            apiPayload['password'] = password;
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
     * Use this endpoint to create a session from token. Provide the **userId** and **secret** parameters from the successful response of authentication flows initiated by token creation. For example, magic URL and phone login.
     *
     * @param {string} params.userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.secret - Secret of a token generated by login methods. For example, the `createMagicURLToken` or `createPhoneToken` methods.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     */
    createSession(params: {
        userId: string;
        secret: string;
    }): Promise<Models.Session>;
    /**
     * Use this endpoint to create a session from token. Provide the **userId** and **secret** parameters from the successful response of authentication flows initiated by token creation. For example, magic URL and phone login.
     *
     * @param {string} userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} secret - Secret of a token generated by login methods. For example, the `createMagicURLToken` or `createPhoneToken` methods.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createSession(userId: string, secret: string): Promise<Models.Session>;
    createSession(
        paramsOrFirst: { userId: string; secret: string } | string,
        ...rest: [string?]
    ): Promise<Models.Session> {
        let params: { userId: string; secret: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                secret: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                secret: rest[0] as string,
            };
        }

        const userId = params.userId;
        const secret = params.secret;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof secret === 'undefined') {
            throw new BunwriteException('Missing required parameter: "secret"');
        }
        const apiPath = '/account/sessions/token';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof secret !== 'undefined') {
            apiPayload['secret'] = secret;
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
     * Use this endpoint to get a logged in user's session using a Session ID. Inputting 'current' will return the current session being used.
     *
     * @param {string} params.sessionId - Session ID. Use the string 'current' to get the current device session.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     */
    getSession(params: { sessionId: string }): Promise<Models.Session>;
    /**
     * Use this endpoint to get a logged in user's session using a Session ID. Inputting 'current' will return the current session being used.
     *
     * @param {string} sessionId - Session ID. Use the string 'current' to get the current device session.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getSession(sessionId: string): Promise<Models.Session>;
    getSession(
        paramsOrFirst: { sessionId: string } | string,
    ): Promise<Models.Session> {
        let params: { sessionId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { sessionId: string };
        } else {
            params = {
                sessionId: paramsOrFirst as string,
            };
        }

        const sessionId = params.sessionId;
        if (typeof sessionId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "sessionId"',
            );
        }
        const apiPath = '/account/sessions/{sessionId}'.replace(
            '{sessionId}',
            encodeURIComponent(String(sessionId)),
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
     * Use this endpoint to extend a session's length. Extending a session is useful when session expiry is short. If the session was created using an OAuth provider, this endpoint refreshes the access token from the provider.
     *
     * @param {string} params.sessionId - Session ID. Use the string 'current' to update the current device session.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     */
    updateSession(params: { sessionId: string }): Promise<Models.Session>;
    /**
     * Use this endpoint to extend a session's length. Extending a session is useful when session expiry is short. If the session was created using an OAuth provider, this endpoint refreshes the access token from the provider.
     *
     * @param {string} sessionId - Session ID. Use the string 'current' to update the current device session.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Session>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateSession(sessionId: string): Promise<Models.Session>;
    updateSession(
        paramsOrFirst: { sessionId: string } | string,
    ): Promise<Models.Session> {
        let params: { sessionId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { sessionId: string };
        } else {
            params = {
                sessionId: paramsOrFirst as string,
            };
        }

        const sessionId = params.sessionId;
        if (typeof sessionId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "sessionId"',
            );
        }
        const apiPath = '/account/sessions/{sessionId}'.replace(
            '{sessionId}',
            encodeURIComponent(String(sessionId)),
        );
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('patch', uri, apiHeaders, apiPayload);
    }

    /**
     * Logout the user. Use 'current' as the session ID to logout on this device, use a session ID to logout on another device. If you're looking to logout the user on all devices, use [Delete Sessions](https://appwrite.io/docs/references/cloud/client-web/account#deleteSessions) instead.
     *
     * @param {string} params.sessionId - Session ID. Use the string 'current' to delete the current device session.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteSession(params: { sessionId: string }): Promise<{}>;
    /**
     * Logout the user. Use 'current' as the session ID to logout on this device, use a session ID to logout on another device. If you're looking to logout the user on all devices, use [Delete Sessions](https://appwrite.io/docs/references/cloud/client-web/account#deleteSessions) instead.
     *
     * @param {string} sessionId - Session ID. Use the string 'current' to delete the current device session.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteSession(sessionId: string): Promise<{}>;
    deleteSession(paramsOrFirst: { sessionId: string } | string): Promise<{}> {
        let params: { sessionId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { sessionId: string };
        } else {
            params = {
                sessionId: paramsOrFirst as string,
            };
        }

        const sessionId = params.sessionId;
        if (typeof sessionId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "sessionId"',
            );
        }
        const apiPath = '/account/sessions/{sessionId}'.replace(
            '{sessionId}',
            encodeURIComponent(String(sessionId)),
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
     * Block the currently logged in user account. Behind the scene, the user record is not deleted but permanently blocked from any access. To completely delete a user, use the Users API instead.
     *
     * @throws {BunwriteException}
     * @returns {Promise<Models.User<Preferences>>}
     */
    updateStatus<
        Preferences extends Models.Preferences = Models.DefaultPreferences,
    >(): Promise<Models.User<Preferences>> {
        const apiPath = '/account/status';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('patch', uri, apiHeaders, apiPayload);
    }

    /**
     * Sends the user an email with a secret key for creating a session. If the email address has never been used, a **new account is created** using the provided `userId`. Otherwise, if the email address is already attached to an account, the **user ID is ignored**. Then, the user will receive an email with the one-time password. Use the returned user ID and secret and submit a request to the [POST /v1/account/sessions/token](https://appwrite.io/docs/references/cloud/client-web/account#createSession) endpoint to complete the login process. The secret sent to the user's email is valid for 15 minutes.
     *
     * A user is limited to 10 active sessions at a time by default. [Learn more about session limits](https://appwrite.io/docs/authentication-security#limits).
     *
     *
     * @param {string} params.userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars. If the email address has never been used, a new account is created using the provided userId. Otherwise, if the email address is already attached to an account, the user ID is ignored.
     * @param {string} params.email - User email.
     * @param {boolean} params.phrase - Toggle for security phrase. If enabled, email will be send with a randomly generated phrase and the phrase will also be included in the response. Confirming phrases match increases the security of your authentication flow.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     */
    createEmailToken(params: {
        userId: string;
        email: string;
        phrase?: boolean;
    }): Promise<Models.Token>;
    /**
     * Sends the user an email with a secret key for creating a session. If the email address has never been used, a **new account is created** using the provided `userId`. Otherwise, if the email address is already attached to an account, the **user ID is ignored**. Then, the user will receive an email with the one-time password. Use the returned user ID and secret and submit a request to the [POST /v1/account/sessions/token](https://appwrite.io/docs/references/cloud/client-web/account#createSession) endpoint to complete the login process. The secret sent to the user's email is valid for 15 minutes.
     *
     * A user is limited to 10 active sessions at a time by default. [Learn more about session limits](https://appwrite.io/docs/authentication-security#limits).
     *
     *
     * @param {string} userId - User ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars. If the email address has never been used, a new account is created using the provided userId. Otherwise, if the email address is already attached to an account, the user ID is ignored.
     * @param {string} email - User email.
     * @param {boolean} phrase - Toggle for security phrase. If enabled, email will be send with a randomly generated phrase and the phrase will also be included in the response. Confirming phrases match increases the security of your authentication flow.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createEmailToken(
        userId: string,
        email: string,
        phrase?: boolean,
    ): Promise<Models.Token>;
    createEmailToken(
        paramsOrFirst:
            { userId: string; email: string; phrase?: boolean } | string,
        ...rest: [string?, boolean?]
    ): Promise<Models.Token> {
        let params: { userId: string; email: string; phrase?: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                email: string;
                phrase?: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                email: rest[0] as string,
                phrase: rest[1] as boolean,
            };
        }

        const userId = params.userId;
        const email = params.email;
        const phrase = params.phrase;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof email === 'undefined') {
            throw new BunwriteException('Missing required parameter: "email"');
        }
        const apiPath = '/account/tokens/email';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof email !== 'undefined') {
            apiPayload['email'] = email;
        }
        if (typeof phrase !== 'undefined') {
            apiPayload['phrase'] = phrase;
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
     * Allow the user to login to their account using the OAuth2 provider of their choice. Each OAuth2 provider should be enabled from the Appwrite console first. Use the success and failure arguments to provide a redirect URL's back to your app when login is completed.
     *
     * If authentication succeeds, `userId` and `secret` of a token will be appended to the success URL as query parameters. These can be used to create a new session using the [Create session](https://appwrite.io/docs/references/cloud/client-web/account#createSession) endpoint.
     *
     * A user is limited to 10 active sessions at a time by default. [Learn more about session limits](https://appwrite.io/docs/authentication-security#limits).
     *
     * @param {OAuthProvider} params.provider - OAuth2 Provider. Currently, supported providers are: amazon, apple, appwrite, auth0, authentik, autodesk, bitbucket, bitly, box, cloudflare, dailymotion, discord, disqus, dropbox, etsy, facebook, figma, fusionauth, github, gitlab, google, huggingface, keycloak, kick, linkedin, microsoft, notion, oidc, okta, paypal, paypalSandbox, podio, resend, salesforce, slack, spotify, stripe, tradeshift, tradeshiftBox, twitch, wordpress, x, yahoo, yammer, yandex, zoho, zoom.
     * @param {string} params.success - URL to redirect back to your app after a successful login attempt.  Only URLs from hostnames in your project's platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @param {string} params.failure - URL to redirect back to your app after a failed login attempt.  Only URLs from hostnames in your project's platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @param {string[]} params.scopes - A list of custom OAuth2 scopes. Check each provider internal docs for a list of supported scopes. Maximum of 100 scopes are allowed, each 4096 characters long.
     * @throws {BunwriteException}
     * @returns {void | string}
     */
    createOAuth2Token(params: {
        provider: OAuthProvider;
        success?: string;
        failure?: string;
        scopes?: string[];
    }): void | string;
    /**
     * Allow the user to login to their account using the OAuth2 provider of their choice. Each OAuth2 provider should be enabled from the Appwrite console first. Use the success and failure arguments to provide a redirect URL's back to your app when login is completed.
     *
     * If authentication succeeds, `userId` and `secret` of a token will be appended to the success URL as query parameters. These can be used to create a new session using the [Create session](https://appwrite.io/docs/references/cloud/client-web/account#createSession) endpoint.
     *
     * A user is limited to 10 active sessions at a time by default. [Learn more about session limits](https://appwrite.io/docs/authentication-security#limits).
     *
     * @param {OAuthProvider} provider - OAuth2 Provider. Currently, supported providers are: amazon, apple, appwrite, auth0, authentik, autodesk, bitbucket, bitly, box, cloudflare, dailymotion, discord, disqus, dropbox, etsy, facebook, figma, fusionauth, github, gitlab, google, huggingface, keycloak, kick, linkedin, microsoft, notion, oidc, okta, paypal, paypalSandbox, podio, resend, salesforce, slack, spotify, stripe, tradeshift, tradeshiftBox, twitch, wordpress, x, yahoo, yammer, yandex, zoho, zoom.
     * @param {string} success - URL to redirect back to your app after a successful login attempt.  Only URLs from hostnames in your project's platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @param {string} failure - URL to redirect back to your app after a failed login attempt.  Only URLs from hostnames in your project's platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @param {string[]} scopes - A list of custom OAuth2 scopes. Check each provider internal docs for a list of supported scopes. Maximum of 100 scopes are allowed, each 4096 characters long.
     * @throws {BunwriteException}
     * @returns {void | string}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createOAuth2Token(
        provider: OAuthProvider,
        success?: string,
        failure?: string,
        scopes?: string[],
    ): void | string;
    createOAuth2Token(
        paramsOrFirst:
            | {
                  provider: OAuthProvider;
                  success?: string;
                  failure?: string;
                  scopes?: string[];
              }
            | OAuthProvider,
        ...rest: [string?, string?, string[]?]
    ): void | string {
        let params: {
            provider: OAuthProvider;
            success?: string;
            failure?: string;
            scopes?: string[];
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            ('provider' in paramsOrFirst ||
                'success' in paramsOrFirst ||
                'failure' in paramsOrFirst ||
                'scopes' in paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                provider: OAuthProvider;
                success?: string;
                failure?: string;
                scopes?: string[];
            };
        } else {
            params = {
                provider: paramsOrFirst as OAuthProvider,
                success: rest[0] as string,
                failure: rest[1] as string,
                scopes: rest[2] as string[],
            };
        }

        const provider = params.provider;
        const success = params.success;
        const failure = params.failure;
        const scopes = params.scopes;

        if (typeof provider === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "provider"',
            );
        }
        const apiPath = '/account/tokens/oauth2/{provider}'.replace(
            '{provider}',
            encodeURIComponent(String(provider)),
        );
        const payload: Payload = {};
        if (typeof success !== 'undefined') {
            payload['success'] = success;
        }
        if (typeof failure !== 'undefined') {
            payload['failure'] = failure;
        }
        if (typeof scopes !== 'undefined') {
            payload['scopes'] = scopes;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        payload['project'] = this.client.config.project;

        for (const [key, value] of Object.entries(Client.flatten(payload))) {
            uri.searchParams.append(key, value);
        }

        if (typeof window !== 'undefined' && window?.location) {
            window.location.href = uri.toString();
            return;
        } else {
            return uri.toString();
        }
    }

    /**
     * Use this endpoint to send a verification message to your user email address to confirm they are the valid owners of that address. Both the **userId** and **secret** arguments will be passed as query parameters to the URL you have provided to be attached to the verification email. The provided URL should redirect the user back to your app and allow you to complete the verification process by verifying both the **userId** and **secret** parameters. Learn more about how to [complete the verification process](https://appwrite.io/docs/references/cloud/client-web/account#updateVerification). The verification link sent to the user's email address is valid for 7 days.
     *
     * Please note that in order to avoid a [Redirect Attack](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md), the only valid redirect URLs are the ones from domains you have set when adding your platforms in the console interface.
     *
     *
     * @param {string} params.url - URL to redirect the user back to your app from the verification email. Only URLs from hostnames in your project platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     */
    createEmailVerification(params: { url: string }): Promise<Models.Token>;
    /**
     * Use this endpoint to send a verification message to your user email address to confirm they are the valid owners of that address. Both the **userId** and **secret** arguments will be passed as query parameters to the URL you have provided to be attached to the verification email. The provided URL should redirect the user back to your app and allow you to complete the verification process by verifying both the **userId** and **secret** parameters. Learn more about how to [complete the verification process](https://appwrite.io/docs/references/cloud/client-web/account#updateVerification). The verification link sent to the user's email address is valid for 7 days.
     *
     * Please note that in order to avoid a [Redirect Attack](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md), the only valid redirect URLs are the ones from domains you have set when adding your platforms in the console interface.
     *
     *
     * @param {string} url - URL to redirect the user back to your app from the verification email. Only URLs from hostnames in your project platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createEmailVerification(url: string): Promise<Models.Token>;
    createEmailVerification(
        paramsOrFirst: { url: string } | string,
    ): Promise<Models.Token> {
        let params: { url: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { url: string };
        } else {
            params = {
                url: paramsOrFirst as string,
            };
        }

        const url = params.url;
        if (typeof url === 'undefined') {
            throw new BunwriteException('Missing required parameter: "url"');
        }
        const apiPath = '/account/verifications/email';
        const apiPayload: Payload = {};
        if (typeof url !== 'undefined') {
            apiPayload['url'] = url;
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
     * Use this endpoint to send a verification message to your user email address to confirm they are the valid owners of that address. Both the **userId** and **secret** arguments will be passed as query parameters to the URL you have provided to be attached to the verification email. The provided URL should redirect the user back to your app and allow you to complete the verification process by verifying both the **userId** and **secret** parameters. Learn more about how to [complete the verification process](https://appwrite.io/docs/references/cloud/client-web/account#updateVerification). The verification link sent to the user's email address is valid for 7 days.
     *
     * Please note that in order to avoid a [Redirect Attack](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md), the only valid redirect URLs are the ones from domains you have set when adding your platforms in the console interface.
     *
     *
     * @param {string} params.url - URL to redirect the user back to your app from the verification email. Only URLs from hostnames in your project platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated This API has been deprecated since 1.8.0. Please use `Account.createEmailVerification` instead.
     */
    createVerification(params: { url: string }): Promise<Models.Token>;
    /**
     * Use this endpoint to send a verification message to your user email address to confirm they are the valid owners of that address. Both the **userId** and **secret** arguments will be passed as query parameters to the URL you have provided to be attached to the verification email. The provided URL should redirect the user back to your app and allow you to complete the verification process by verifying both the **userId** and **secret** parameters. Learn more about how to [complete the verification process](https://appwrite.io/docs/references/cloud/client-web/account#updateVerification). The verification link sent to the user's email address is valid for 7 days.
     *
     * Please note that in order to avoid a [Redirect Attack](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md), the only valid redirect URLs are the ones from domains you have set when adding your platforms in the console interface.
     *
     *
     * @param {string} url - URL to redirect the user back to your app from the verification email. Only URLs from hostnames in your project platform list are allowed. This requirement helps to prevent an [open redirect](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) attack against your project API.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createVerification(url: string): Promise<Models.Token>;
    createVerification(
        paramsOrFirst: { url: string } | string,
    ): Promise<Models.Token> {
        let params: { url: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { url: string };
        } else {
            params = {
                url: paramsOrFirst as string,
            };
        }

        const url = params.url;
        if (typeof url === 'undefined') {
            throw new BunwriteException('Missing required parameter: "url"');
        }
        const apiPath = '/account/verifications/email';
        const apiPayload: Payload = {};
        if (typeof url !== 'undefined') {
            apiPayload['url'] = url;
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
     * Use this endpoint to complete the user email verification process. Use both the **userId** and **secret** parameters that were attached to your app URL to verify the user email ownership. If confirmed this route will return a 200 status code.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.secret - Valid verification token.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     */
    updateEmailVerification(params: {
        userId: string;
        secret: string;
    }): Promise<Models.Token>;
    /**
     * Use this endpoint to complete the user email verification process. Use both the **userId** and **secret** parameters that were attached to your app URL to verify the user email ownership. If confirmed this route will return a 200 status code.
     *
     * @param {string} userId - User ID.
     * @param {string} secret - Valid verification token.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEmailVerification(
        userId: string,
        secret: string,
    ): Promise<Models.Token>;
    updateEmailVerification(
        paramsOrFirst: { userId: string; secret: string } | string,
        ...rest: [string?]
    ): Promise<Models.Token> {
        let params: { userId: string; secret: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                secret: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                secret: rest[0] as string,
            };
        }

        const userId = params.userId;
        const secret = params.secret;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof secret === 'undefined') {
            throw new BunwriteException('Missing required parameter: "secret"');
        }
        const apiPath = '/account/verifications/email';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof secret !== 'undefined') {
            apiPayload['secret'] = secret;
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
     * Use this endpoint to complete the user email verification process. Use both the **userId** and **secret** parameters that were attached to your app URL to verify the user email ownership. If confirmed this route will return a 200 status code.
     *
     * @param {string} params.userId - User ID.
     * @param {string} params.secret - Valid verification token.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated This API has been deprecated since 1.8.0. Please use `Account.updateEmailVerification` instead.
     */
    updateVerification(params: {
        userId: string;
        secret: string;
    }): Promise<Models.Token>;
    /**
     * Use this endpoint to complete the user email verification process. Use both the **userId** and **secret** parameters that were attached to your app URL to verify the user email ownership. If confirmed this route will return a 200 status code.
     *
     * @param {string} userId - User ID.
     * @param {string} secret - Valid verification token.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Token>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateVerification(userId: string, secret: string): Promise<Models.Token>;
    updateVerification(
        paramsOrFirst: { userId: string; secret: string } | string,
        ...rest: [string?]
    ): Promise<Models.Token> {
        let params: { userId: string; secret: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                userId: string;
                secret: string;
            };
        } else {
            params = {
                userId: paramsOrFirst as string,
                secret: rest[0] as string,
            };
        }

        const userId = params.userId;
        const secret = params.secret;
        if (typeof userId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "userId"');
        }
        if (typeof secret === 'undefined') {
            throw new BunwriteException('Missing required parameter: "secret"');
        }
        const apiPath = '/account/verifications/email';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof secret !== 'undefined') {
            apiPayload['secret'] = secret;
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
     * Use this endpoint to create a JSON Web Token. You can use the resulting JWT to authenticate on behalf of the current user when working with the Appwrite server-side API and SDKs. The JWT secret is valid for 15 minutes from its creation and will be invalid if the user will logout in that time frame.
     *
     * @param {number} params.duration - Time in seconds before JWT expires. Default duration is 900 seconds, and maximum is 3600 seconds.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Jwt>}
     */
    createJWT(params?: { duration?: number }): Promise<Models.Jwt>;
    /**
     * Use this endpoint to create a JSON Web Token. You can use the resulting JWT to authenticate on behalf of the current user when working with the Appwrite server-side API and SDKs. The JWT secret is valid for 15 minutes from its creation and will be invalid if the user will logout in that time frame.
     *
     * @param {number} duration - Time in seconds before JWT expires. Default duration is 900 seconds, and maximum is 3600 seconds.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Jwt>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createJWT(duration?: number): Promise<Models.Jwt>;
    createJWT(
        paramsOrFirst?: { duration?: number } | number,
    ): Promise<Models.Jwt> {
        let params: { duration?: number };

        if (
            typeof paramsOrFirst === 'undefined' ||
            (paramsOrFirst &&
                typeof paramsOrFirst === 'object' &&
                !Array.isArray(paramsOrFirst))
        ) {
            params = (paramsOrFirst || {}) as { duration?: number };
        } else {
            params = {
                duration: paramsOrFirst as number,
            };
        }

        const duration = params.duration;

        const apiPath = '/account/jwts';
        const payload: Payload = {};
        if (typeof duration !== 'undefined') {
            payload['duration'] = duration;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Appwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('post', uri, apiHeaders, payload);
    }
}
