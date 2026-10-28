// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

import { ProjectAuthMethodId } from '../enums/project-auth-method-id';
import { ProjectPolicyId } from '../enums/project-policy-id';
import { ProjectProtocolId } from '../enums/project-protocol-id';
import { ProjectServiceId } from '../enums/project-service-id';
import { ProjectEmailTemplateId } from '../enums/project-email-template-id';
import { ProjectEmailTemplateLocale } from '../enums/project-email-template-locale';
export class Project {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a project.
     *
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    get(): Promise<Models.Project> {
        const apiPath = '/project';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Update properties of a specific auth method. Use this endpoint to enable or disable a method in your project.
     *
     * @param {ProjectAuthMethodId} params.methodId - Auth Method ID. Possible values: email-password,magic-url,email-otp,anonymous,invites,jwt,phone
     * @param {boolean} params.enabled - Auth method status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateAuthMethod(params: {
        methodId: ProjectAuthMethodId;
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Update properties of a specific auth method. Use this endpoint to enable or disable a method in your project.
     *
     * @param {ProjectAuthMethodId} methodId - Auth Method ID. Possible values: email-password,magic-url,email-otp,anonymous,invites,jwt,phone
     * @param {boolean} enabled - Auth method status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateAuthMethod(
        methodId: ProjectAuthMethodId,
        enabled: boolean,
    ): Promise<Models.Project>;
    updateAuthMethod(
        paramsOrFirst:
            | { methodId: ProjectAuthMethodId; enabled: boolean }
            | ProjectAuthMethodId,
        ...rest: [boolean?]
    ): Promise<Models.Project> {
        let params: { methodId: ProjectAuthMethodId; enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            ('methodId' in paramsOrFirst || 'enabled' in paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                methodId: ProjectAuthMethodId;
                enabled: boolean;
            };
        } else {
            params = {
                methodId: paramsOrFirst as ProjectAuthMethodId,
                enabled: rest[0] as boolean,
            };
        }

        const methodId = params.methodId;
        const enabled = params.enabled;
        if (typeof methodId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "methodId"',
            );
        }
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/auth-methods/{methodId}'.replace(
            '{methodId}',
            encodeURIComponent(String(methodId)),
        );
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Get a list of all mock phones in the project. This endpoint returns an array of all mock phones and their OTPs.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Only supported methods are limit and offset
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumberList>}
     */
    listMockPhones(params?: {
        queries?: string[];
        total?: boolean;
    }): Promise<Models.MockNumberList>;
    /**
     * Get a list of all mock phones in the project. This endpoint returns an array of all mock phones and their OTPs.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Only supported methods are limit and offset
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumberList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listMockPhones(
        queries?: string[],
        total?: boolean,
    ): Promise<Models.MockNumberList>;
    listMockPhones(
        paramsOrFirst?: { queries?: string[]; total?: boolean } | string[],
        ...rest: [boolean?]
    ): Promise<Models.MockNumberList> {
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
        const apiPath = '/project/mock-phones';
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
     * Create a new mock phone for your project. Use this endpoint to register a mock phone number and its sign-in OTP for your testers.
     *
     * @param {string} params.number - Phone number to associate with the mock phone. Must be a valid E.164 formatted phone number.
     * @param {string} params.otp - One-time password (OTP) to associate with the mock phone. Must be a 6-digit numeric code.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumber>}
     */
    createMockPhone(params: {
        number: string;
        otp: string;
    }): Promise<Models.MockNumber>;
    /**
     * Create a new mock phone for your project. Use this endpoint to register a mock phone number and its sign-in OTP for your testers.
     *
     * @param {string} number - Phone number to associate with the mock phone. Must be a valid E.164 formatted phone number.
     * @param {string} otp - One-time password (OTP) to associate with the mock phone. Must be a 6-digit numeric code.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumber>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createMockPhone(number: string, otp: string): Promise<Models.MockNumber>;
    createMockPhone(
        paramsOrFirst: { number: string; otp: string } | string,
        ...rest: [string?]
    ): Promise<Models.MockNumber> {
        let params: { number: string; otp: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { number: string; otp: string };
        } else {
            params = {
                number: paramsOrFirst as string,
                otp: rest[0] as string,
            };
        }

        const number = params.number;
        const otp = params.otp;
        if (typeof number === 'undefined') {
            throw new BunwriteException('Missing required parameter: "number"');
        }
        if (typeof otp === 'undefined') {
            throw new BunwriteException('Missing required parameter: "otp"');
        }
        const apiPath = '/project/mock-phones';
        const apiPayload: Payload = {};
        if (typeof number !== 'undefined') {
            apiPayload['number'] = number;
        }
        if (typeof otp !== 'undefined') {
            apiPayload['otp'] = otp;
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
     * Get a mock phone by its unique number. This endpoint returns the mock phone's OTP.
     *
     * @param {string} params.number - Phone number associated with the mock phone. Must be a valid E.164 formatted phone number.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumber>}
     */
    getMockPhone(params: { number: string }): Promise<Models.MockNumber>;
    /**
     * Get a mock phone by its unique number. This endpoint returns the mock phone's OTP.
     *
     * @param {string} number - Phone number associated with the mock phone. Must be a valid E.164 formatted phone number.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumber>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getMockPhone(number: string): Promise<Models.MockNumber>;
    getMockPhone(
        paramsOrFirst: { number: string } | string,
    ): Promise<Models.MockNumber> {
        let params: { number: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { number: string };
        } else {
            params = {
                number: paramsOrFirst as string,
            };
        }

        const number = params.number;
        if (typeof number === 'undefined') {
            throw new BunwriteException('Missing required parameter: "number"');
        }
        const apiPath = '/project/mock-phones/{number}'.replace(
            '{number}',
            encodeURIComponent(String(number)),
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
     * Update a mock phone by its unique number. Use this endpoint to update the mock phone's OTP.
     *
     * @param {string} params.number - Phone number associated with the mock phone. Must be a valid E.164 formatted phone number.
     * @param {string} params.otp - One-time password (OTP) to associate with the mock phone. Must be a 6-digit numeric code.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumber>}
     */
    updateMockPhone(params: {
        number: string;
        otp: string;
    }): Promise<Models.MockNumber>;
    /**
     * Update a mock phone by its unique number. Use this endpoint to update the mock phone's OTP.
     *
     * @param {string} number - Phone number associated with the mock phone. Must be a valid E.164 formatted phone number.
     * @param {string} otp - One-time password (OTP) to associate with the mock phone. Must be a 6-digit numeric code.
     * @throws {BunwriteException}
     * @returns {Promise<Models.MockNumber>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateMockPhone(number: string, otp: string): Promise<Models.MockNumber>;
    updateMockPhone(
        paramsOrFirst: { number: string; otp: string } | string,
        ...rest: [string?]
    ): Promise<Models.MockNumber> {
        let params: { number: string; otp: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { number: string; otp: string };
        } else {
            params = {
                number: paramsOrFirst as string,
                otp: rest[0] as string,
            };
        }

        const number = params.number;
        const otp = params.otp;
        if (typeof number === 'undefined') {
            throw new BunwriteException('Missing required parameter: "number"');
        }
        if (typeof otp === 'undefined') {
            throw new BunwriteException('Missing required parameter: "otp"');
        }
        const apiPath = '/project/mock-phones/{number}'.replace(
            '{number}',
            encodeURIComponent(String(number)),
        );
        const apiPayload: Payload = {};
        if (typeof otp !== 'undefined') {
            apiPayload['otp'] = otp;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'application/json',
            accept: 'application/json',
        };

        return this.client.call('put', uri, apiHeaders, apiPayload);
    }

    /**
     * Delete a mock phone by its unique number. This endpoint removes the mock phone and its OTP configuration from the project.
     *
     * @param {string} params.number - Phone number associated with the mock phone. Must be a valid E.164 formatted phone number.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteMockPhone(params: { number: string }): Promise<{}>;
    /**
     * Delete a mock phone by its unique number. This endpoint removes the mock phone and its OTP configuration from the project.
     *
     * @param {string} number - Phone number associated with the mock phone. Must be a valid E.164 formatted phone number.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteMockPhone(number: string): Promise<{}>;
    deleteMockPhone(paramsOrFirst: { number: string } | string): Promise<{}> {
        let params: { number: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { number: string };
        } else {
            params = {
                number: paramsOrFirst as string,
            };
        }

        const number = params.number;
        if (typeof number === 'undefined') {
            throw new BunwriteException('Missing required parameter: "number"');
        }
        const apiPath = '/project/mock-phones/{number}'.replace(
            '{number}',
            encodeURIComponent(String(number)),
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
     * Get a list of all project policies and their current configuration.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Only supported methods are limit and offset
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.PolicyList>}
     */
    listPolicies(params?: {
        queries?: string[];
        total?: boolean;
    }): Promise<Models.PolicyList>;
    /**
     * Get a list of all project policies and their current configuration.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Only supported methods are limit and offset
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.PolicyList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listPolicies(
        queries?: string[],
        total?: boolean,
    ): Promise<Models.PolicyList>;
    listPolicies(
        paramsOrFirst?: { queries?: string[]; total?: boolean } | string[],
        ...rest: [boolean?]
    ): Promise<Models.PolicyList> {
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
        const apiPath = '/project/policies';
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
     * Configures if aliased emails such as subaddresses and emails with suffixes are denied during new users sign-ups and email updates.
     *
     * @param {boolean} params.enabled - Set whether or not to block aliased emails during signup and email updates.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateDenyAliasedEmailPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Configures if aliased emails such as subaddresses and emails with suffixes are denied during new users sign-ups and email updates.
     *
     * @param {boolean} enabled - Set whether or not to block aliased emails during signup and email updates.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateDenyAliasedEmailPolicy(enabled: boolean): Promise<Models.Project>;
    updateDenyAliasedEmailPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/deny-aliased-email';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Configures if disposable emails from known temporary domains are denied during new users sign-ups and email updates.
     *
     * @param {boolean} params.enabled - Set whether or not to block disposable email addresses during signup and email updates.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateDenyDisposableEmailPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Configures if disposable emails from known temporary domains are denied during new users sign-ups and email updates.
     *
     * @param {boolean} enabled - Set whether or not to block disposable email addresses during signup and email updates.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateDenyDisposableEmailPolicy(enabled: boolean): Promise<Models.Project>;
    updateDenyDisposableEmailPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/deny-disposable-email';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Configures if emails from free providers such as Gmail or Yahoo are denied during new users sign-ups and email updates.
     *
     * @param {boolean} params.enabled - Set whether or not to block free email addresses during signup and email updates.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateDenyFreeEmailPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Configures if emails from free providers such as Gmail or Yahoo are denied during new users sign-ups and email updates.
     *
     * @param {boolean} enabled - Set whether or not to block free email addresses during signup and email updates.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateDenyFreeEmailPolicy(enabled: boolean): Promise<Models.Project>;
    updateDenyFreeEmailPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/deny-free-email';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Updating this policy allows you to control if team members can see other members information. When enabled, all team members can see ID, name, email, phone number, and MFA status of other members..
     *
     * @param {boolean} params.userId - Set to true if you want make user ID visible to all team members, or false to hide it.
     * @param {boolean} params.userEmail - Set to true if you want make user email visible to all team members, or false to hide it.
     * @param {boolean} params.userPhone - Set to true if you want make user phone number visible to all team members, or false to hide it.
     * @param {boolean} params.userName - Set to true if you want make user name visible to all team members, or false to hide it.
     * @param {boolean} params.userMFA - Set to true if you want make user MFA status visible to all team members, or false to hide it.
     * @param {boolean} params.userAccessedAt - Set to true if you want make user last access time visible to all team members, or false to hide it.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateMembershipPrivacyPolicy(params?: {
        userId?: boolean;
        userEmail?: boolean;
        userPhone?: boolean;
        userName?: boolean;
        userMFA?: boolean;
        userAccessedAt?: boolean;
    }): Promise<Models.Project>;
    /**
     * Updating this policy allows you to control if team members can see other members information. When enabled, all team members can see ID, name, email, phone number, and MFA status of other members..
     *
     * @param {boolean} userId - Set to true if you want make user ID visible to all team members, or false to hide it.
     * @param {boolean} userEmail - Set to true if you want make user email visible to all team members, or false to hide it.
     * @param {boolean} userPhone - Set to true if you want make user phone number visible to all team members, or false to hide it.
     * @param {boolean} userName - Set to true if you want make user name visible to all team members, or false to hide it.
     * @param {boolean} userMFA - Set to true if you want make user MFA status visible to all team members, or false to hide it.
     * @param {boolean} userAccessedAt - Set to true if you want make user last access time visible to all team members, or false to hide it.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateMembershipPrivacyPolicy(
        userId?: boolean,
        userEmail?: boolean,
        userPhone?: boolean,
        userName?: boolean,
        userMFA?: boolean,
        userAccessedAt?: boolean,
    ): Promise<Models.Project>;
    updateMembershipPrivacyPolicy(
        paramsOrFirst?:
            | {
                  userId?: boolean;
                  userEmail?: boolean;
                  userPhone?: boolean;
                  userName?: boolean;
                  userMFA?: boolean;
                  userAccessedAt?: boolean;
              }
            | boolean,
        ...rest: [boolean?, boolean?, boolean?, boolean?, boolean?]
    ): Promise<Models.Project> {
        let params: {
            userId?: boolean;
            userEmail?: boolean;
            userPhone?: boolean;
            userName?: boolean;
            userMFA?: boolean;
            userAccessedAt?: boolean;
        };

        if (
            !paramsOrFirst ||
            (paramsOrFirst &&
                typeof paramsOrFirst === 'object' &&
                !Array.isArray(paramsOrFirst))
        ) {
            params = (paramsOrFirst || {}) as {
                userId?: boolean;
                userEmail?: boolean;
                userPhone?: boolean;
                userName?: boolean;
                userMFA?: boolean;
                userAccessedAt?: boolean;
            };
        } else {
            params = {
                userId: paramsOrFirst as boolean,
                userEmail: rest[0] as boolean,
                userPhone: rest[1] as boolean,
                userName: rest[2] as boolean,
                userMFA: rest[3] as boolean,
                userAccessedAt: rest[4] as boolean,
            };
        }

        const userId = params.userId;
        const userEmail = params.userEmail;
        const userPhone = params.userPhone;
        const userName = params.userName;
        const userMFA = params.userMFA;
        const userAccessedAt = params.userAccessedAt;
        const apiPath = '/project/policies/membership-privacy';
        const apiPayload: Payload = {};
        if (typeof userId !== 'undefined') {
            apiPayload['userId'] = userId;
        }
        if (typeof userEmail !== 'undefined') {
            apiPayload['userEmail'] = userEmail;
        }
        if (typeof userPhone !== 'undefined') {
            apiPayload['userPhone'] = userPhone;
        }
        if (typeof userName !== 'undefined') {
            apiPayload['userName'] = userName;
        }
        if (typeof userMFA !== 'undefined') {
            apiPayload['userMFA'] = userMFA;
        }
        if (typeof userAccessedAt !== 'undefined') {
            apiPayload['userAccessedAt'] = userAccessedAt;
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
     * Updating this policy allows you to control if new passwords are checked against most common passwords dictionary. When enabled, and user changes their password, password must not be contained in the dictionary.
     *
     * @param {boolean} params.enabled - Toggle password dictionary policy. Set to true if you want password change to block passwords in the dictionary, or false to allow them. When changing this policy, existing passwords remain valid.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updatePasswordDictionaryPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Updating this policy allows you to control if new passwords are checked against most common passwords dictionary. When enabled, and user changes their password, password must not be contained in the dictionary.
     *
     * @param {boolean} enabled - Toggle password dictionary policy. Set to true if you want password change to block passwords in the dictionary, or false to allow them. When changing this policy, existing passwords remain valid.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePasswordDictionaryPolicy(enabled: boolean): Promise<Models.Project>;
    updatePasswordDictionaryPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/password-dictionary';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Updates one of password strength policies. Based on total length configured, previous password hashes are stored, and users cannot choose a new password that is already stored in the passwird history list, when updating an user password, or setting new one through password recovery.
     *
     * Keep in mind, while password history policy is disabled, the history is not being stored. Enabling the policy will not have any history on existing users, and it will only start to collect and enforce the policy on password changes since the policy is enabled.
     *
     * @param {number} params.total - Set the password history length per user. Value can be between 1 and 20, or null to disable the limit.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updatePasswordHistoryPolicy(params: {
        total?: number;
    }): Promise<Models.Project>;
    /**
     * Updates one of password strength policies. Based on total length configured, previous password hashes are stored, and users cannot choose a new password that is already stored in the passwird history list, when updating an user password, or setting new one through password recovery.
     *
     * Keep in mind, while password history policy is disabled, the history is not being stored. Enabling the policy will not have any history on existing users, and it will only start to collect and enforce the policy on password changes since the policy is enabled.
     *
     * @param {number} total - Set the password history length per user. Value can be between 1 and 20, or null to disable the limit.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePasswordHistoryPolicy(total?: number): Promise<Models.Project>;
    updatePasswordHistoryPolicy(
        paramsOrFirst?: { total?: number } | number,
    ): Promise<Models.Project> {
        let params: { total?: number };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { total?: number };
        } else {
            params = {
                total: paramsOrFirst as number,
            };
        }

        const total = params.total;
        if (typeof total === 'undefined') {
            throw new BunwriteException('Missing required parameter: "total"');
        }
        const apiPath = '/project/policies/password-history';
        const apiPayload: Payload = {};
        if (typeof total !== 'undefined') {
            apiPayload['total'] = total;
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
     * Updating this policy allows you to control if password strength is checked against personal data. When enabled, and user sets or changes their password, the password must not contain user ID, name, email or phone number.
     *
     * @param {boolean} params.enabled - Toggle password personal data policy. Set to true if you want to block passwords including user's personal data, or false to allow it. When changing this policy, existing passwords remain valid.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updatePasswordPersonalDataPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Updating this policy allows you to control if password strength is checked against personal data. When enabled, and user sets or changes their password, the password must not contain user ID, name, email or phone number.
     *
     * @param {boolean} enabled - Toggle password personal data policy. Set to true if you want to block passwords including user's personal data, or false to allow it. When changing this policy, existing passwords remain valid.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updatePasswordPersonalDataPolicy(enabled: boolean): Promise<Models.Project>;
    updatePasswordPersonalDataPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/password-personal-data';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Updating this policy allows you to control if email alert is sent upon session creation. When enabled, and user signs into their account, they will be sent an email notification. There is an exception, the first session after a new sign up does not trigger an alert, even if the policy is enabled.
     *
     * @param {boolean} params.enabled - Toggle session alert policy. Set to true if you want users to receive email notifications when a sessions are created for their users, or false to not send email alerts.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateSessionAlertPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Updating this policy allows you to control if email alert is sent upon session creation. When enabled, and user signs into their account, they will be sent an email notification. There is an exception, the first session after a new sign up does not trigger an alert, even if the policy is enabled.
     *
     * @param {boolean} enabled - Toggle session alert policy. Set to true if you want users to receive email notifications when a sessions are created for their users, or false to not send email alerts.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateSessionAlertPolicy(enabled: boolean): Promise<Models.Project>;
    updateSessionAlertPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/session-alert';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Update maximum duration how long sessions created within a project should stay active for.
     *
     * @param {number} params.duration - Maximum session length in seconds. Minium allowed value is 60 seconds, and maximum is 1 year, which is 31536000 seconds.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateSessionDurationPolicy(params: {
        duration: number;
    }): Promise<Models.Project>;
    /**
     * Update maximum duration how long sessions created within a project should stay active for.
     *
     * @param {number} duration - Maximum session length in seconds. Minium allowed value is 60 seconds, and maximum is 1 year, which is 31536000 seconds.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateSessionDurationPolicy(duration: number): Promise<Models.Project>;
    updateSessionDurationPolicy(
        paramsOrFirst: { duration: number } | number,
    ): Promise<Models.Project> {
        let params: { duration: number };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { duration: number };
        } else {
            params = {
                duration: paramsOrFirst as number,
            };
        }

        const duration = params.duration;
        if (typeof duration === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "duration"',
            );
        }
        const apiPath = '/project/policies/session-duration';
        const apiPayload: Payload = {};
        if (typeof duration !== 'undefined') {
            apiPayload['duration'] = duration;
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
     * Updating this policy allows you to control if existing sessions should be invalidated when a password of a user is changed. When enabled, and user changes their password, they will be logged out of all their devices.
     *
     * @param {boolean} params.enabled - Toggle session invalidation policy. Set to true if you want password change to invalidate all sessions of an user, or false to keep sessions active.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateSessionInvalidationPolicy(params: {
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Updating this policy allows you to control if existing sessions should be invalidated when a password of a user is changed. When enabled, and user changes their password, they will be logged out of all their devices.
     *
     * @param {boolean} enabled - Toggle session invalidation policy. Set to true if you want password change to invalidate all sessions of an user, or false to keep sessions active.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateSessionInvalidationPolicy(enabled: boolean): Promise<Models.Project>;
    updateSessionInvalidationPolicy(
        paramsOrFirst: { enabled: boolean } | boolean,
    ): Promise<Models.Project> {
        let params: { enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { enabled: boolean };
        } else {
            params = {
                enabled: paramsOrFirst as boolean,
            };
        }

        const enabled = params.enabled;
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/policies/session-invalidation';
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Update the maximum number of sessions allowed per user. When the limit is hit, the oldest session will be deleted to make room for new one.
     *
     * @param {number} params.total - Set the maximum number of sessions allowed per user. Value can be between 1 and 100.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateSessionLimitPolicy(params: {
        total: number;
    }): Promise<Models.Project>;
    /**
     * Update the maximum number of sessions allowed per user. When the limit is hit, the oldest session will be deleted to make room for new one.
     *
     * @param {number} total - Set the maximum number of sessions allowed per user. Value can be between 1 and 100.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateSessionLimitPolicy(total: number): Promise<Models.Project>;
    updateSessionLimitPolicy(
        paramsOrFirst: { total: number } | number,
    ): Promise<Models.Project> {
        let params: { total: number };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { total: number };
        } else {
            params = {
                total: paramsOrFirst as number,
            };
        }

        const total = params.total;
        if (typeof total === 'undefined') {
            throw new BunwriteException('Missing required parameter: "total"');
        }
        const apiPath = '/project/policies/session-limit';
        const apiPayload: Payload = {};
        if (typeof total !== 'undefined') {
            apiPayload['total'] = total;
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
     * Update the maximum number of users in the project. When the limit is hit or amount of existing users already exceeded the limit, all users remain active, but new user sign up will be prohibited.
     *
     * @param {number} params.total - Set the maximum number of users allowed in the project. Value can be between 0 and 10000. Use 0 or null to disable the limit.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateUserLimitPolicy(params: { total?: number }): Promise<Models.Project>;
    /**
     * Update the maximum number of users in the project. When the limit is hit or amount of existing users already exceeded the limit, all users remain active, but new user sign up will be prohibited.
     *
     * @param {number} total - Set the maximum number of users allowed in the project. Value can be between 0 and 10000. Use 0 or null to disable the limit.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateUserLimitPolicy(total?: number): Promise<Models.Project>;
    updateUserLimitPolicy(
        paramsOrFirst?: { total?: number } | number,
    ): Promise<Models.Project> {
        let params: { total?: number };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { total?: number };
        } else {
            params = {
                total: paramsOrFirst as number,
            };
        }

        const total = params.total;
        if (typeof total === 'undefined') {
            throw new BunwriteException('Missing required parameter: "total"');
        }
        const apiPath = '/project/policies/user-limit';
        const apiPayload: Payload = {};
        if (typeof total !== 'undefined') {
            apiPayload['total'] = total;
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
     * Get a policy by its unique ID. This endpoint returns the current configuration for the requested project policy.
     *
     * @param {ProjectPolicyId} params.policyId - Policy ID. Can be one of: password-dictionary, password-history, password-strength, password-personal-data, session-alert, session-duration, session-invalidation, session-limit, user-limit, membership-privacy, mfa-factors, deny-aliased-email, deny-disposable-email, deny-free-email, deny-corporate-email.
     * @throws {BunwriteException}
     * @returns {Promise<Models.PolicyPasswordDictionary | Models.PolicyPasswordHistory | Models.PolicyPasswordStrength | Models.PolicyPasswordPersonalData | Models.PolicySessionAlert | Models.PolicySessionDuration | Models.PolicySessionInvalidation | Models.PolicySessionLimit | Models.PolicyUserLimit | Models.PolicyMembershipPrivacy | Models.PolicyMfaFactors | Models.PolicyDenyAliasedEmail | Models.PolicyDenyDisposableEmail | Models.PolicyDenyFreeEmail | Models.PolicyDenyCorporateEmail>}
     */
    getPolicy(params: {
        policyId: ProjectPolicyId;
    }): Promise<
        | Models.PolicyPasswordDictionary
        | Models.PolicyPasswordHistory
        | Models.PolicyPasswordStrength
        | Models.PolicyPasswordPersonalData
        | Models.PolicySessionAlert
        | Models.PolicySessionDuration
        | Models.PolicySessionInvalidation
        | Models.PolicySessionLimit
        | Models.PolicyUserLimit
        | Models.PolicyMembershipPrivacy
        | Models.PolicyMfaFactors
        | Models.PolicyDenyAliasedEmail
        | Models.PolicyDenyDisposableEmail
        | Models.PolicyDenyFreeEmail
        | Models.PolicyDenyCorporateEmail
    >;
    /**
     * Get a policy by its unique ID. This endpoint returns the current configuration for the requested project policy.
     *
     * @param {ProjectPolicyId} policyId - Policy ID. Can be one of: password-dictionary, password-history, password-strength, password-personal-data, session-alert, session-duration, session-invalidation, session-limit, user-limit, membership-privacy, mfa-factors, deny-aliased-email, deny-disposable-email, deny-free-email, deny-corporate-email.
     * @throws {BunwriteException}
     * @returns {Promise<Models.PolicyPasswordDictionary | Models.PolicyPasswordHistory | Models.PolicyPasswordStrength | Models.PolicyPasswordPersonalData | Models.PolicySessionAlert | Models.PolicySessionDuration | Models.PolicySessionInvalidation | Models.PolicySessionLimit | Models.PolicyUserLimit | Models.PolicyMembershipPrivacy | Models.PolicyMfaFactors | Models.PolicyDenyAliasedEmail | Models.PolicyDenyDisposableEmail | Models.PolicyDenyFreeEmail | Models.PolicyDenyCorporateEmail>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getPolicy(
        policyId: ProjectPolicyId,
    ): Promise<
        | Models.PolicyPasswordDictionary
        | Models.PolicyPasswordHistory
        | Models.PolicyPasswordStrength
        | Models.PolicyPasswordPersonalData
        | Models.PolicySessionAlert
        | Models.PolicySessionDuration
        | Models.PolicySessionInvalidation
        | Models.PolicySessionLimit
        | Models.PolicyUserLimit
        | Models.PolicyMembershipPrivacy
        | Models.PolicyMfaFactors
        | Models.PolicyDenyAliasedEmail
        | Models.PolicyDenyDisposableEmail
        | Models.PolicyDenyFreeEmail
        | Models.PolicyDenyCorporateEmail
    >;
    getPolicy(
        paramsOrFirst: { policyId: ProjectPolicyId } | ProjectPolicyId,
    ): Promise<
        | Models.PolicyPasswordDictionary
        | Models.PolicyPasswordHistory
        | Models.PolicyPasswordStrength
        | Models.PolicyPasswordPersonalData
        | Models.PolicySessionAlert
        | Models.PolicySessionDuration
        | Models.PolicySessionInvalidation
        | Models.PolicySessionLimit
        | Models.PolicyUserLimit
        | Models.PolicyMembershipPrivacy
        | Models.PolicyMfaFactors
        | Models.PolicyDenyAliasedEmail
        | Models.PolicyDenyDisposableEmail
        | Models.PolicyDenyFreeEmail
        | Models.PolicyDenyCorporateEmail
    > {
        let params: { policyId: ProjectPolicyId };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            'policyId' in paramsOrFirst
        ) {
            params = (paramsOrFirst || {}) as { policyId: ProjectPolicyId };
        } else {
            params = {
                policyId: paramsOrFirst as ProjectPolicyId,
            };
        }

        const policyId = params.policyId;
        if (typeof policyId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "policyId"',
            );
        }
        const apiPath = '/project/policies/{policyId}'.replace(
            '{policyId}',
            encodeURIComponent(String(policyId)),
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
     * Update properties of a specific protocol. Use this endpoint to enable or disable a protocol in your project.
     *
     * @param {ProjectProtocolId} params.protocolId - Protocol name. Can be one of: rest, graphql, websocket
     * @param {boolean} params.enabled - Protocol status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateProtocol(params: {
        protocolId: ProjectProtocolId;
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Update properties of a specific protocol. Use this endpoint to enable or disable a protocol in your project.
     *
     * @param {ProjectProtocolId} protocolId - Protocol name. Can be one of: rest, graphql, websocket
     * @param {boolean} enabled - Protocol status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateProtocol(
        protocolId: ProjectProtocolId,
        enabled: boolean,
    ): Promise<Models.Project>;
    updateProtocol(
        paramsOrFirst:
            | { protocolId: ProjectProtocolId; enabled: boolean }
            | ProjectProtocolId,
        ...rest: [boolean?]
    ): Promise<Models.Project> {
        let params: { protocolId: ProjectProtocolId; enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            ('protocolId' in paramsOrFirst || 'enabled' in paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                protocolId: ProjectProtocolId;
                enabled: boolean;
            };
        } else {
            params = {
                protocolId: paramsOrFirst as ProjectProtocolId,
                enabled: rest[0] as boolean,
            };
        }

        const protocolId = params.protocolId;
        const enabled = params.enabled;
        if (typeof protocolId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "protocolId"',
            );
        }
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/protocols/{protocolId}'.replace(
            '{protocolId}',
            encodeURIComponent(String(protocolId)),
        );
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Update properties of a specific service. Use this endpoint to enable or disable a service in your project.
     *
     * @param {ProjectServiceId} params.serviceId - Service name. Can be one of: account, avatars, databases, tablesdb, locale, health, project, storage, teams, users, vcs, sites, functions, proxy, graphql, migrations, messaging, advisor, oauth2
     * @param {boolean} params.enabled - Service status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     */
    updateService(params: {
        serviceId: ProjectServiceId;
        enabled: boolean;
    }): Promise<Models.Project>;
    /**
     * Update properties of a specific service. Use this endpoint to enable or disable a service in your project.
     *
     * @param {ProjectServiceId} serviceId - Service name. Can be one of: account, avatars, databases, tablesdb, locale, health, project, storage, teams, users, vcs, sites, functions, proxy, graphql, migrations, messaging, advisor, oauth2
     * @param {boolean} enabled - Service status.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Project>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateService(
        serviceId: ProjectServiceId,
        enabled: boolean,
    ): Promise<Models.Project>;
    updateService(
        paramsOrFirst:
            | { serviceId: ProjectServiceId; enabled: boolean }
            | ProjectServiceId,
        ...rest: [boolean?]
    ): Promise<Models.Project> {
        let params: { serviceId: ProjectServiceId; enabled: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            ('serviceId' in paramsOrFirst || 'enabled' in paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                serviceId: ProjectServiceId;
                enabled: boolean;
            };
        } else {
            params = {
                serviceId: paramsOrFirst as ProjectServiceId,
                enabled: rest[0] as boolean,
            };
        }

        const serviceId = params.serviceId;
        const enabled = params.enabled;
        if (typeof serviceId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "serviceId"',
            );
        }
        if (typeof enabled === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "enabled"',
            );
        }
        const apiPath = '/project/services/{serviceId}'.replace(
            '{serviceId}',
            encodeURIComponent(String(serviceId)),
        );
        const apiPayload: Payload = {};
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
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
     * Get a list of all custom email templates configured for the project. This endpoint returns an array of all configured email templates and their locales.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Only supported methods are limit and offset
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.EmailTemplateList>}
     */
    listEmailTemplates(params?: {
        queries?: string[];
        total?: boolean;
    }): Promise<Models.EmailTemplateList>;
    /**
     * Get a list of all custom email templates configured for the project. This endpoint returns an array of all configured email templates and their locales.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Only supported methods are limit and offset
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.EmailTemplateList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listEmailTemplates(
        queries?: string[],
        total?: boolean,
    ): Promise<Models.EmailTemplateList>;
    listEmailTemplates(
        paramsOrFirst?: { queries?: string[]; total?: boolean } | string[],
        ...rest: [boolean?]
    ): Promise<Models.EmailTemplateList> {
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
        const apiPath = '/project/templates/email';
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
     * Update a custom email template for the specified locale and type. Use this endpoint to modify the content of your email templates.
     *
     * @param {ProjectEmailTemplateId} params.templateId - Custom email template type. Can be one of: verification, magicSession, recovery, invitation, mfaChallenge, sessionAlert, otpSession
     * @param {ProjectEmailTemplateLocale} params.locale - Custom email template locale. If left empty, the fallback locale (en) will be used.
     * @param {string} params.subject - Subject of the email template. Can be up to 255 characters.
     * @param {string} params.message - Plain or HTML body of the email template message. Can be up to 10MB of content.
     * @param {string} params.senderName - Name of the email sender.
     * @param {string} params.senderEmail - Email of the sender. Pass an empty string to clear a previously set value.
     * @param {string} params.replyToEmail - Reply to email. Pass an empty string to clear a previously set value.
     * @param {string} params.replyToName - Reply to name.
     * @throws {BunwriteException}
     * @returns {Promise<Models.EmailTemplate>}
     */
    updateEmailTemplate(params: {
        templateId: ProjectEmailTemplateId;
        locale?: ProjectEmailTemplateLocale;
        subject?: string;
        message?: string;
        senderName?: string;
        senderEmail?: string;
        replyToEmail?: string;
        replyToName?: string;
    }): Promise<Models.EmailTemplate>;
    /**
     * Update a custom email template for the specified locale and type. Use this endpoint to modify the content of your email templates.
     *
     * @param {ProjectEmailTemplateId} templateId - Custom email template type. Can be one of: verification, magicSession, recovery, invitation, mfaChallenge, sessionAlert, otpSession
     * @param {ProjectEmailTemplateLocale} locale - Custom email template locale. If left empty, the fallback locale (en) will be used.
     * @param {string} subject - Subject of the email template. Can be up to 255 characters.
     * @param {string} message - Plain or HTML body of the email template message. Can be up to 10MB of content.
     * @param {string} senderName - Name of the email sender.
     * @param {string} senderEmail - Email of the sender. Pass an empty string to clear a previously set value.
     * @param {string} replyToEmail - Reply to email. Pass an empty string to clear a previously set value.
     * @param {string} replyToName - Reply to name.
     * @throws {BunwriteException}
     * @returns {Promise<Models.EmailTemplate>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateEmailTemplate(
        templateId: ProjectEmailTemplateId,
        locale?: ProjectEmailTemplateLocale,
        subject?: string,
        message?: string,
        senderName?: string,
        senderEmail?: string,
        replyToEmail?: string,
        replyToName?: string,
    ): Promise<Models.EmailTemplate>;
    updateEmailTemplate(
        paramsOrFirst:
            | {
                  templateId: ProjectEmailTemplateId;
                  locale?: ProjectEmailTemplateLocale;
                  subject?: string;
                  message?: string;
                  senderName?: string;
                  senderEmail?: string;
                  replyToEmail?: string;
                  replyToName?: string;
              }
            | ProjectEmailTemplateId,
        ...rest: [
            ProjectEmailTemplateLocale?,
            string?,
            string?,
            string?,
            string?,
            string?,
            string?,
        ]
    ): Promise<Models.EmailTemplate> {
        let params: {
            templateId: ProjectEmailTemplateId;
            locale?: ProjectEmailTemplateLocale;
            subject?: string;
            message?: string;
            senderName?: string;
            senderEmail?: string;
            replyToEmail?: string;
            replyToName?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            ('templateId' in paramsOrFirst ||
                'locale' in paramsOrFirst ||
                'subject' in paramsOrFirst ||
                'message' in paramsOrFirst ||
                'senderName' in paramsOrFirst ||
                'senderEmail' in paramsOrFirst ||
                'replyToEmail' in paramsOrFirst ||
                'replyToName' in paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                templateId: ProjectEmailTemplateId;
                locale?: ProjectEmailTemplateLocale;
                subject?: string;
                message?: string;
                senderName?: string;
                senderEmail?: string;
                replyToEmail?: string;
                replyToName?: string;
            };
        } else {
            params = {
                templateId: paramsOrFirst as ProjectEmailTemplateId,
                locale: rest[0] as ProjectEmailTemplateLocale,
                subject: rest[1] as string,
                message: rest[2] as string,
                senderName: rest[3] as string,
                senderEmail: rest[4] as string,
                replyToEmail: rest[5] as string,
                replyToName: rest[6] as string,
            };
        }

        const templateId = params.templateId;
        const locale = params.locale;
        const subject = params.subject;
        const message = params.message;
        const senderName = params.senderName;
        const senderEmail = params.senderEmail;
        const replyToEmail = params.replyToEmail;
        const replyToName = params.replyToName;
        if (typeof templateId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "templateId"',
            );
        }
        const apiPath = '/project/templates/email';
        const apiPayload: Payload = {};
        if (typeof templateId !== 'undefined') {
            apiPayload['templateId'] = templateId;
        }
        if (typeof locale !== 'undefined') {
            apiPayload['locale'] = locale;
        }
        if (typeof subject !== 'undefined') {
            apiPayload['subject'] = subject;
        }
        if (typeof message !== 'undefined') {
            apiPayload['message'] = message;
        }
        if (typeof senderName !== 'undefined') {
            apiPayload['senderName'] = senderName;
        }
        if (typeof senderEmail !== 'undefined') {
            apiPayload['senderEmail'] = senderEmail;
        }
        if (typeof replyToEmail !== 'undefined') {
            apiPayload['replyToEmail'] = replyToEmail;
        }
        if (typeof replyToName !== 'undefined') {
            apiPayload['replyToName'] = replyToName;
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
     * Get a custom email template for the specified locale and type. This endpoint returns the template content, subject, and other configuration details.
     *
     * @param {ProjectEmailTemplateId} params.templateId - Custom email template type. Can be one of: verification, magicSession, recovery, invitation, mfaChallenge, sessionAlert, otpSession
     * @param {ProjectEmailTemplateLocale} params.locale - Custom email template locale. If left empty, the fallback locale (en) will be used.
     * @throws {BunwriteException}
     * @returns {Promise<Models.EmailTemplate>}
     */
    getEmailTemplate(params: {
        templateId: ProjectEmailTemplateId;
        locale?: ProjectEmailTemplateLocale;
    }): Promise<Models.EmailTemplate>;
    /**
     * Get a custom email template for the specified locale and type. This endpoint returns the template content, subject, and other configuration details.
     *
     * @param {ProjectEmailTemplateId} templateId - Custom email template type. Can be one of: verification, magicSession, recovery, invitation, mfaChallenge, sessionAlert, otpSession
     * @param {ProjectEmailTemplateLocale} locale - Custom email template locale. If left empty, the fallback locale (en) will be used.
     * @throws {BunwriteException}
     * @returns {Promise<Models.EmailTemplate>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getEmailTemplate(
        templateId: ProjectEmailTemplateId,
        locale?: ProjectEmailTemplateLocale,
    ): Promise<Models.EmailTemplate>;
    getEmailTemplate(
        paramsOrFirst:
            | {
                  templateId: ProjectEmailTemplateId;
                  locale?: ProjectEmailTemplateLocale;
              }
            | ProjectEmailTemplateId,
        ...rest: [ProjectEmailTemplateLocale?]
    ): Promise<Models.EmailTemplate> {
        let params: {
            templateId: ProjectEmailTemplateId;
            locale?: ProjectEmailTemplateLocale;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst) &&
            ('templateId' in paramsOrFirst || 'locale' in paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                templateId: ProjectEmailTemplateId;
                locale?: ProjectEmailTemplateLocale;
            };
        } else {
            params = {
                templateId: paramsOrFirst as ProjectEmailTemplateId,
                locale: rest[0] as ProjectEmailTemplateLocale,
            };
        }

        const templateId = params.templateId;
        const locale = params.locale;
        if (typeof templateId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "templateId"',
            );
        }
        const apiPath = '/project/templates/email/{templateId}'.replace(
            '{templateId}',
            encodeURIComponent(String(templateId)),
        );
        const apiPayload: Payload = {};
        if (typeof locale !== 'undefined') {
            apiPayload['locale'] = locale;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }
}
