// Copied from node-appwrite 29.0.0 (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,
// keeping only what Bunwrite serves. Edit that script, not this file.

import { BunwriteException, Client, type Payload, type UploadProgress } from '../client';
import type { Models } from '../models';
import { InputFile } from '../inputFile';

import { Framework } from '../enums/framework';
import { BuildRuntime } from '../enums/build-runtime';
import { Adapter } from '../enums/adapter';
import { ProjectKeyScopes } from '../enums/project-key-scopes';
import { DeploymentDownloadType } from '../enums/deployment-download-type';
export class Sites {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Get a list of all the project's sites. You can use the query params to filter your results.
     *
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, enabled, framework, deploymentId, buildCommand, installCommand, outputDirectory, installationId
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.SiteList>}
     */
    list(params?: {
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.SiteList>;
    /**
     * Get a list of all the project's sites. You can use the query params to filter your results.
     *
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: name, enabled, framework, deploymentId, buildCommand, installCommand, outputDirectory, installationId
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.SiteList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    list(
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.SiteList>;
    list(
        paramsOrFirst?:
            { queries?: string[]; search?: string; total?: boolean } | string[],
        ...rest: [string?, boolean?]
    ): Promise<Models.SiteList> {
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
        const apiPath = '/sites';
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
     * Create a new site.
     *
     * @param {string} params.siteId - Site ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} params.name - Site name. Max length: 128 chars.
     * @param {Framework} params.framework - Sites framework.
     * @param {BuildRuntime} params.buildRuntime - Runtime to use during build step.
     * @param {boolean} params.enabled - Is site enabled? When set to 'disabled', users cannot access the site but Server SDKs with and API key can still access the site. No data is lost when this is toggled.
     * @param {boolean} params.logging - When disabled, request logs will exclude logs and errors, and site responses will be slightly faster.
     * @param {number} params.timeout - Maximum request time in seconds.
     * @param {string} params.installCommand - Install Command.
     * @param {string} params.buildCommand - Build Command.
     * @param {string} params.startCommand - Custom start command. Leave empty to use default.
     * @param {string} params.outputDirectory - Output Directory for site.
     * @param {Adapter} params.adapter - Framework adapter defining rendering strategy. Allowed values are: static, ssr
     * @param {string} params.installationId - Bunwrite Installation ID for VCS (Version Control System) deployment.
     * @param {string} params.fallbackFile - Fallback file for single page application sites.
     * @param {string} params.providerRepositoryId - Repository ID of the repo linked to the site.
     * @param {string} params.providerBranch - Production branch for the repo linked to the site.
     * @param {boolean} params.providerSilentMode - Is the VCS (Version Control System) connection in silent mode for the repo linked to the site? In silent mode, comments will not be made on commits and pull requests.
     * @param {string} params.providerRootDirectory - Path to site code in the linked repo.
     * @param {string[]} params.providerBranches - List of branch name patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all branches.
     * @param {string[]} params.providerPaths - List of file path patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all file changes.
     * @param {string} params.buildSpecification - Build specification for the site deployments.
     * @param {string} params.runtimeSpecification - Runtime specification for the SSR executions.
     * @param {number} params.deploymentRetention - Days to keep non-active deployments before deletion. Value 0 means all deployments will be kept.
     * @param {ProjectKeyScopes[]} params.scopes - List of scopes allowed for API key auto-generated for every site build and SSR execution. Maximum of 200 scopes are allowed.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     */
    create(params: {
        siteId: string;
        name: string;
        framework: Framework;
        buildRuntime: BuildRuntime;
        enabled?: boolean;
        logging?: boolean;
        timeout?: number;
        installCommand?: string;
        buildCommand?: string;
        startCommand?: string;
        outputDirectory?: string;
        adapter?: Adapter;
        installationId?: string;
        fallbackFile?: string;
        /** Bunwrite: function that answers /api/* on the site's domain. */
        apiFunctionId?: string;
        /** Bunwrite: custom domain, such as www.example.com. */
        domain?: string;
        providerRepositoryId?: string;
        providerBranch?: string;
        providerSilentMode?: boolean;
        providerRootDirectory?: string;
        providerBranches?: string[];
        providerPaths?: string[];
        buildSpecification?: string;
        runtimeSpecification?: string;
        deploymentRetention?: number;
        scopes?: ProjectKeyScopes[];
    }): Promise<Models.Site>;
    /**
     * Create a new site.
     *
     * @param {string} siteId - Site ID. Choose a custom ID or generate a random ID with `ID.unique()`. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char. Max length is 36 chars.
     * @param {string} name - Site name. Max length: 128 chars.
     * @param {Framework} framework - Sites framework.
     * @param {BuildRuntime} buildRuntime - Runtime to use during build step.
     * @param {boolean} enabled - Is site enabled? When set to 'disabled', users cannot access the site but Server SDKs with and API key can still access the site. No data is lost when this is toggled.
     * @param {boolean} logging - When disabled, request logs will exclude logs and errors, and site responses will be slightly faster.
     * @param {number} timeout - Maximum request time in seconds.
     * @param {string} installCommand - Install Command.
     * @param {string} buildCommand - Build Command.
     * @param {string} startCommand - Custom start command. Leave empty to use default.
     * @param {string} outputDirectory - Output Directory for site.
     * @param {Adapter} adapter - Framework adapter defining rendering strategy. Allowed values are: static, ssr
     * @param {string} installationId - Bunwrite Installation ID for VCS (Version Control System) deployment.
     * @param {string} fallbackFile - Fallback file for single page application sites.
     * @param {string} providerRepositoryId - Repository ID of the repo linked to the site.
     * @param {string} providerBranch - Production branch for the repo linked to the site.
     * @param {boolean} providerSilentMode - Is the VCS (Version Control System) connection in silent mode for the repo linked to the site? In silent mode, comments will not be made on commits and pull requests.
     * @param {string} providerRootDirectory - Path to site code in the linked repo.
     * @param {string[]} providerBranches - List of branch name patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all branches.
     * @param {string[]} providerPaths - List of file path patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all file changes.
     * @param {string} buildSpecification - Build specification for the site deployments.
     * @param {string} runtimeSpecification - Runtime specification for the SSR executions.
     * @param {number} deploymentRetention - Days to keep non-active deployments before deletion. Value 0 means all deployments will be kept.
     * @param {ProjectKeyScopes[]} scopes - List of scopes allowed for API key auto-generated for every site build and SSR execution. Maximum of 200 scopes are allowed.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    create(
        siteId: string,
        name: string,
        framework: Framework,
        buildRuntime: BuildRuntime,
        enabled?: boolean,
        logging?: boolean,
        timeout?: number,
        installCommand?: string,
        buildCommand?: string,
        startCommand?: string,
        outputDirectory?: string,
        adapter?: Adapter,
        installationId?: string,
        fallbackFile?: string,
        providerRepositoryId?: string,
        providerBranch?: string,
        providerSilentMode?: boolean,
        providerRootDirectory?: string,
        providerBranches?: string[],
        providerPaths?: string[],
        buildSpecification?: string,
        runtimeSpecification?: string,
        deploymentRetention?: number,
        scopes?: ProjectKeyScopes[],
    ): Promise<Models.Site>;
    create(
        paramsOrFirst:
            | {
                  siteId: string;
                  name: string;
                  framework: Framework;
                  buildRuntime: BuildRuntime;
                  enabled?: boolean;
                  logging?: boolean;
                  timeout?: number;
                  installCommand?: string;
                  buildCommand?: string;
                  startCommand?: string;
                  outputDirectory?: string;
                  adapter?: Adapter;
                  installationId?: string;
                  fallbackFile?: string;
                  /** Bunwrite: function that answers /api/* on the site's domain. */
                  apiFunctionId?: string;
                  /** Bunwrite: custom domain, such as www.example.com. */
                  domain?: string;
                  providerRepositoryId?: string;
                  providerBranch?: string;
                  providerSilentMode?: boolean;
                  providerRootDirectory?: string;
                  providerBranches?: string[];
                  providerPaths?: string[];
                  buildSpecification?: string;
                  runtimeSpecification?: string;
                  deploymentRetention?: number;
                  scopes?: ProjectKeyScopes[];
              }
            | string,
        ...rest: [
            string?,
            Framework?,
            BuildRuntime?,
            boolean?,
            boolean?,
            number?,
            string?,
            string?,
            string?,
            string?,
            Adapter?,
            string?,
            string?,
            string?,
            string?,
            boolean?,
            string?,
            string[]?,
            string[]?,
            string?,
            string?,
            number?,
            ProjectKeyScopes[]?,
        ]
    ): Promise<Models.Site> {
        let params: {
            siteId: string;
            name: string;
            framework: Framework;
            buildRuntime: BuildRuntime;
            enabled?: boolean;
            logging?: boolean;
            timeout?: number;
            installCommand?: string;
            buildCommand?: string;
            startCommand?: string;
            outputDirectory?: string;
            adapter?: Adapter;
            installationId?: string;
            fallbackFile?: string;
            /** Bunwrite: function that answers /api/* on the site's domain. */
            apiFunctionId?: string;
            /** Bunwrite: custom domain, such as www.example.com. */
            domain?: string;
            providerRepositoryId?: string;
            providerBranch?: string;
            providerSilentMode?: boolean;
            providerRootDirectory?: string;
            providerBranches?: string[];
            providerPaths?: string[];
            buildSpecification?: string;
            runtimeSpecification?: string;
            deploymentRetention?: number;
            scopes?: ProjectKeyScopes[];
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                name: string;
                framework: Framework;
                buildRuntime: BuildRuntime;
                enabled?: boolean;
                logging?: boolean;
                timeout?: number;
                installCommand?: string;
                buildCommand?: string;
                startCommand?: string;
                outputDirectory?: string;
                adapter?: Adapter;
                installationId?: string;
                fallbackFile?: string;
                /** Bunwrite: function that answers /api/* on the site's domain. */
                apiFunctionId?: string;
                /** Bunwrite: custom domain, such as www.example.com. */
                domain?: string;
                providerRepositoryId?: string;
                providerBranch?: string;
                providerSilentMode?: boolean;
                providerRootDirectory?: string;
                providerBranches?: string[];
                providerPaths?: string[];
                buildSpecification?: string;
                runtimeSpecification?: string;
                deploymentRetention?: number;
                scopes?: ProjectKeyScopes[];
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                name: rest[0] as string,
                framework: rest[1] as Framework,
                buildRuntime: rest[2] as BuildRuntime,
                enabled: rest[3] as boolean,
                logging: rest[4] as boolean,
                timeout: rest[5] as number,
                installCommand: rest[6] as string,
                buildCommand: rest[7] as string,
                startCommand: rest[8] as string,
                outputDirectory: rest[9] as string,
                adapter: rest[10] as Adapter,
                installationId: rest[11] as string,
                fallbackFile: rest[12] as string,
                providerRepositoryId: rest[13] as string,
                providerBranch: rest[14] as string,
                providerSilentMode: rest[15] as boolean,
                providerRootDirectory: rest[16] as string,
                providerBranches: rest[17] as string[],
                providerPaths: rest[18] as string[],
                buildSpecification: rest[19] as string,
                runtimeSpecification: rest[20] as string,
                deploymentRetention: rest[21] as number,
                scopes: rest[22] as ProjectKeyScopes[],
            };
        }

        const siteId = params.siteId;
        const name = params.name;
        const framework = params.framework;
        const buildRuntime = params.buildRuntime;
        const enabled = params.enabled;
        const logging = params.logging;
        const timeout = params.timeout;
        const installCommand = params.installCommand;
        const buildCommand = params.buildCommand;
        const startCommand = params.startCommand;
        const outputDirectory = params.outputDirectory;
        const adapter = params.adapter;
        const installationId = params.installationId;
        const fallbackFile = params.fallbackFile;
        const { apiFunctionId, domain } = params as { apiFunctionId?: string; domain?: string };
        const providerRepositoryId = params.providerRepositoryId;
        const providerBranch = params.providerBranch;
        const providerSilentMode = params.providerSilentMode;
        const providerRootDirectory = params.providerRootDirectory;
        const providerBranches = params.providerBranches;
        const providerPaths = params.providerPaths;
        const buildSpecification = params.buildSpecification;
        const runtimeSpecification = params.runtimeSpecification;
        const deploymentRetention = params.deploymentRetention;
        const scopes = params.scopes;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        if (typeof framework === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "framework"',
            );
        }
        if (typeof buildRuntime === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "buildRuntime"',
            );
        }
        const apiPath = '/sites';
        const apiPayload: Payload = {};
        if (typeof siteId !== 'undefined') {
            apiPayload['siteId'] = siteId;
        }
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof framework !== 'undefined') {
            apiPayload['framework'] = framework;
        }
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
        }
        if (typeof logging !== 'undefined') {
            apiPayload['logging'] = logging;
        }
        if (typeof timeout !== 'undefined') {
            apiPayload['timeout'] = timeout;
        }
        if (typeof installCommand !== 'undefined') {
            apiPayload['installCommand'] = installCommand;
        }
        if (typeof buildCommand !== 'undefined') {
            apiPayload['buildCommand'] = buildCommand;
        }
        if (typeof startCommand !== 'undefined') {
            apiPayload['startCommand'] = startCommand;
        }
        if (typeof outputDirectory !== 'undefined') {
            apiPayload['outputDirectory'] = outputDirectory;
        }
        if (typeof buildRuntime !== 'undefined') {
            apiPayload['buildRuntime'] = buildRuntime;
        }
        if (typeof adapter !== 'undefined') {
            apiPayload['adapter'] = adapter;
        }
        if (typeof installationId !== 'undefined') {
            apiPayload['installationId'] = installationId;
        }
        if (typeof fallbackFile !== 'undefined') {
            apiPayload['fallbackFile'] = fallbackFile;
        }
        if (typeof apiFunctionId !== 'undefined') {
            apiPayload['apiFunctionId'] = apiFunctionId;
        }
        if (typeof domain !== 'undefined') {
            apiPayload['domain'] = domain;
        }
        if (typeof providerRepositoryId !== 'undefined') {
            apiPayload['providerRepositoryId'] = providerRepositoryId;
        }
        if (typeof providerBranch !== 'undefined') {
            apiPayload['providerBranch'] = providerBranch;
        }
        if (typeof providerSilentMode !== 'undefined') {
            apiPayload['providerSilentMode'] = providerSilentMode;
        }
        if (typeof providerRootDirectory !== 'undefined') {
            apiPayload['providerRootDirectory'] = providerRootDirectory;
        }
        if (typeof providerBranches !== 'undefined') {
            apiPayload['providerBranches'] = providerBranches;
        }
        if (typeof providerPaths !== 'undefined') {
            apiPayload['providerPaths'] = providerPaths;
        }
        if (typeof buildSpecification !== 'undefined') {
            apiPayload['buildSpecification'] = buildSpecification;
        }
        if (typeof runtimeSpecification !== 'undefined') {
            apiPayload['runtimeSpecification'] = runtimeSpecification;
        }
        if (typeof deploymentRetention !== 'undefined') {
            apiPayload['deploymentRetention'] = deploymentRetention;
        }
        if (typeof scopes !== 'undefined') {
            apiPayload['scopes'] = scopes;
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
     * Get a list of all frameworks that are currently available on the server instance.
     *
     * @throws {BunwriteException}
     * @returns {Promise<Models.FrameworkList>}
     */
    listFrameworks(): Promise<Models.FrameworkList> {
        const apiPath = '/sites/frameworks';
        const apiPayload: Payload = {};
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * List allowed site specifications for this instance.
     *
     * @param {string} params.type - Specification type to list. Can be one of: runtimes, builds. Defaults to runtimes.
     * @throws {BunwriteException}
     * @returns {Promise<Models.SpecificationList>}
     */
    listSpecifications(params?: {
        type?: string;
    }): Promise<Models.SpecificationList>;
    /**
     * List allowed site specifications for this instance.
     *
     * @param {string} type - Specification type to list. Can be one of: runtimes, builds. Defaults to runtimes.
     * @throws {BunwriteException}
     * @returns {Promise<Models.SpecificationList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listSpecifications(type?: string): Promise<Models.SpecificationList>;
    listSpecifications(
        paramsOrFirst?: { type?: string } | string,
    ): Promise<Models.SpecificationList> {
        let params: { type?: string };

        if (
            !paramsOrFirst ||
            (paramsOrFirst &&
                typeof paramsOrFirst === 'object' &&
                !Array.isArray(paramsOrFirst))
        ) {
            params = (paramsOrFirst || {}) as { type?: string };
        } else {
            params = {
                type: paramsOrFirst as string,
            };
        }

        const type = params.type;
        const apiPath = '/sites/specifications';
        const apiPayload: Payload = {};
        if (typeof type !== 'undefined') {
            apiPayload['type'] = type;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Get a site by its unique ID.
     *
     * @param {string} params.siteId - Site ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     */
    get(params: { siteId: string }): Promise<Models.Site>;
    /**
     * Get a site by its unique ID.
     *
     * @param {string} siteId - Site ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    get(siteId: string): Promise<Models.Site>;
    get(paramsOrFirst: { siteId: string } | string): Promise<Models.Site> {
        let params: { siteId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { siteId: string };
        } else {
            params = {
                siteId: paramsOrFirst as string,
            };
        }

        const siteId = params.siteId;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        const apiPath = '/sites/{siteId}'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
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
     * Update site by its unique ID.
     *
     * @param {string} params.siteId - Site ID.
     * @param {string} params.name - Site name. Max length: 128 chars.
     * @param {Framework} params.framework - Sites framework.
     * @param {boolean} params.enabled - Is site enabled? When set to 'disabled', users cannot access the site but Server SDKs with and API key can still access the site. No data is lost when this is toggled.
     * @param {boolean} params.logging - When disabled, request logs will exclude logs and errors, and site responses will be slightly faster.
     * @param {number} params.timeout - Maximum request time in seconds.
     * @param {string} params.installCommand - Install Command.
     * @param {string} params.buildCommand - Build Command.
     * @param {string} params.startCommand - Custom start command. Leave empty to use default.
     * @param {string} params.outputDirectory - Output Directory for site.
     * @param {BuildRuntime} params.buildRuntime - Runtime to use during build step.
     * @param {Adapter} params.adapter - Framework adapter defining rendering strategy. Allowed values are: static, ssr
     * @param {string} params.fallbackFile - Fallback file for single page application sites.
     * @param {string} params.installationId - Bunwrite Installation ID for VCS (Version Control System) deployment.
     * @param {string} params.providerRepositoryId - Repository ID of the repo linked to the site.
     * @param {string} params.providerBranch - Production branch for the repo linked to the site.
     * @param {boolean} params.providerSilentMode - Is the VCS (Version Control System) connection in silent mode for the repo linked to the site? In silent mode, comments will not be made on commits and pull requests.
     * @param {string} params.providerRootDirectory - Path to site code in the linked repo.
     * @param {string[]} params.providerBranches - List of branch name patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all branches.
     * @param {string[]} params.providerPaths - List of file path patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all file changes.
     * @param {string} params.buildSpecification - Build specification for the site deployments.
     * @param {string} params.runtimeSpecification - Runtime specification for the SSR executions.
     * @param {number} params.deploymentRetention - Days to keep non-active deployments before deletion. Value 0 means all deployments will be kept.
     * @param {ProjectKeyScopes[]} params.scopes - List of scopes allowed for API key auto-generated for every site build and SSR execution. Maximum of 200 scopes are allowed.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     */
    update(params: {
        siteId: string;
        name: string;
        framework: Framework;
        enabled?: boolean;
        logging?: boolean;
        timeout?: number;
        installCommand?: string;
        buildCommand?: string;
        startCommand?: string;
        outputDirectory?: string;
        buildRuntime?: BuildRuntime;
        adapter?: Adapter;
        fallbackFile?: string;
        /** Bunwrite: function that answers /api/* on the site's domain. */
        apiFunctionId?: string;
        /** Bunwrite: custom domain, such as www.example.com. */
        domain?: string;
        installationId?: string;
        providerRepositoryId?: string;
        providerBranch?: string;
        providerSilentMode?: boolean;
        providerRootDirectory?: string;
        providerBranches?: string[];
        providerPaths?: string[];
        buildSpecification?: string;
        runtimeSpecification?: string;
        deploymentRetention?: number;
        scopes?: ProjectKeyScopes[];
    }): Promise<Models.Site>;
    /**
     * Update site by its unique ID.
     *
     * @param {string} siteId - Site ID.
     * @param {string} name - Site name. Max length: 128 chars.
     * @param {Framework} framework - Sites framework.
     * @param {boolean} enabled - Is site enabled? When set to 'disabled', users cannot access the site but Server SDKs with and API key can still access the site. No data is lost when this is toggled.
     * @param {boolean} logging - When disabled, request logs will exclude logs and errors, and site responses will be slightly faster.
     * @param {number} timeout - Maximum request time in seconds.
     * @param {string} installCommand - Install Command.
     * @param {string} buildCommand - Build Command.
     * @param {string} startCommand - Custom start command. Leave empty to use default.
     * @param {string} outputDirectory - Output Directory for site.
     * @param {BuildRuntime} buildRuntime - Runtime to use during build step.
     * @param {Adapter} adapter - Framework adapter defining rendering strategy. Allowed values are: static, ssr
     * @param {string} fallbackFile - Fallback file for single page application sites.
     * @param {string} installationId - Bunwrite Installation ID for VCS (Version Control System) deployment.
     * @param {string} providerRepositoryId - Repository ID of the repo linked to the site.
     * @param {string} providerBranch - Production branch for the repo linked to the site.
     * @param {boolean} providerSilentMode - Is the VCS (Version Control System) connection in silent mode for the repo linked to the site? In silent mode, comments will not be made on commits and pull requests.
     * @param {string} providerRootDirectory - Path to site code in the linked repo.
     * @param {string[]} providerBranches - List of branch name patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all branches.
     * @param {string[]} providerPaths - List of file path patterns to trigger automatic deployments. Supports wildcards. Leave empty to deploy on all file changes.
     * @param {string} buildSpecification - Build specification for the site deployments.
     * @param {string} runtimeSpecification - Runtime specification for the SSR executions.
     * @param {number} deploymentRetention - Days to keep non-active deployments before deletion. Value 0 means all deployments will be kept.
     * @param {ProjectKeyScopes[]} scopes - List of scopes allowed for API key auto-generated for every site build and SSR execution. Maximum of 200 scopes are allowed.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    update(
        siteId: string,
        name: string,
        framework: Framework,
        enabled?: boolean,
        logging?: boolean,
        timeout?: number,
        installCommand?: string,
        buildCommand?: string,
        startCommand?: string,
        outputDirectory?: string,
        buildRuntime?: BuildRuntime,
        adapter?: Adapter,
        fallbackFile?: string,
        installationId?: string,
        providerRepositoryId?: string,
        providerBranch?: string,
        providerSilentMode?: boolean,
        providerRootDirectory?: string,
        providerBranches?: string[],
        providerPaths?: string[],
        buildSpecification?: string,
        runtimeSpecification?: string,
        deploymentRetention?: number,
        scopes?: ProjectKeyScopes[],
    ): Promise<Models.Site>;
    update(
        paramsOrFirst:
            | {
                  siteId: string;
                  name: string;
                  framework: Framework;
                  enabled?: boolean;
                  logging?: boolean;
                  timeout?: number;
                  installCommand?: string;
                  buildCommand?: string;
                  startCommand?: string;
                  outputDirectory?: string;
                  buildRuntime?: BuildRuntime;
                  adapter?: Adapter;
                  fallbackFile?: string;
                  /** Bunwrite: function that answers /api/* on the site's domain. */
                  apiFunctionId?: string;
                  /** Bunwrite: custom domain, such as www.example.com. */
                  domain?: string;
                  installationId?: string;
                  providerRepositoryId?: string;
                  providerBranch?: string;
                  providerSilentMode?: boolean;
                  providerRootDirectory?: string;
                  providerBranches?: string[];
                  providerPaths?: string[];
                  buildSpecification?: string;
                  runtimeSpecification?: string;
                  deploymentRetention?: number;
                  scopes?: ProjectKeyScopes[];
              }
            | string,
        ...rest: [
            string?,
            Framework?,
            boolean?,
            boolean?,
            number?,
            string?,
            string?,
            string?,
            string?,
            BuildRuntime?,
            Adapter?,
            string?,
            string?,
            string?,
            string?,
            boolean?,
            string?,
            string[]?,
            string[]?,
            string?,
            string?,
            number?,
            ProjectKeyScopes[]?,
        ]
    ): Promise<Models.Site> {
        let params: {
            siteId: string;
            name: string;
            framework: Framework;
            enabled?: boolean;
            logging?: boolean;
            timeout?: number;
            installCommand?: string;
            buildCommand?: string;
            startCommand?: string;
            outputDirectory?: string;
            buildRuntime?: BuildRuntime;
            adapter?: Adapter;
            fallbackFile?: string;
            /** Bunwrite: function that answers /api/* on the site's domain. */
            apiFunctionId?: string;
            /** Bunwrite: custom domain, such as www.example.com. */
            domain?: string;
            installationId?: string;
            providerRepositoryId?: string;
            providerBranch?: string;
            providerSilentMode?: boolean;
            providerRootDirectory?: string;
            providerBranches?: string[];
            providerPaths?: string[];
            buildSpecification?: string;
            runtimeSpecification?: string;
            deploymentRetention?: number;
            scopes?: ProjectKeyScopes[];
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                name: string;
                framework: Framework;
                enabled?: boolean;
                logging?: boolean;
                timeout?: number;
                installCommand?: string;
                buildCommand?: string;
                startCommand?: string;
                outputDirectory?: string;
                buildRuntime?: BuildRuntime;
                adapter?: Adapter;
                fallbackFile?: string;
                /** Bunwrite: function that answers /api/* on the site's domain. */
                apiFunctionId?: string;
                /** Bunwrite: custom domain, such as www.example.com. */
                domain?: string;
                installationId?: string;
                providerRepositoryId?: string;
                providerBranch?: string;
                providerSilentMode?: boolean;
                providerRootDirectory?: string;
                providerBranches?: string[];
                providerPaths?: string[];
                buildSpecification?: string;
                runtimeSpecification?: string;
                deploymentRetention?: number;
                scopes?: ProjectKeyScopes[];
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                name: rest[0] as string,
                framework: rest[1] as Framework,
                enabled: rest[2] as boolean,
                logging: rest[3] as boolean,
                timeout: rest[4] as number,
                installCommand: rest[5] as string,
                buildCommand: rest[6] as string,
                startCommand: rest[7] as string,
                outputDirectory: rest[8] as string,
                buildRuntime: rest[9] as BuildRuntime,
                adapter: rest[10] as Adapter,
                fallbackFile: rest[11] as string,
                installationId: rest[12] as string,
                providerRepositoryId: rest[13] as string,
                providerBranch: rest[14] as string,
                providerSilentMode: rest[15] as boolean,
                providerRootDirectory: rest[16] as string,
                providerBranches: rest[17] as string[],
                providerPaths: rest[18] as string[],
                buildSpecification: rest[19] as string,
                runtimeSpecification: rest[20] as string,
                deploymentRetention: rest[21] as number,
                scopes: rest[22] as ProjectKeyScopes[],
            };
        }

        const siteId = params.siteId;
        const name = params.name;
        const framework = params.framework;
        const enabled = params.enabled;
        const logging = params.logging;
        const timeout = params.timeout;
        const installCommand = params.installCommand;
        const buildCommand = params.buildCommand;
        const startCommand = params.startCommand;
        const outputDirectory = params.outputDirectory;
        const buildRuntime = params.buildRuntime;
        const adapter = params.adapter;
        const fallbackFile = params.fallbackFile;
        const { apiFunctionId, domain } = params as { apiFunctionId?: string; domain?: string };
        const installationId = params.installationId;
        const providerRepositoryId = params.providerRepositoryId;
        const providerBranch = params.providerBranch;
        const providerSilentMode = params.providerSilentMode;
        const providerRootDirectory = params.providerRootDirectory;
        const providerBranches = params.providerBranches;
        const providerPaths = params.providerPaths;
        const buildSpecification = params.buildSpecification;
        const runtimeSpecification = params.runtimeSpecification;
        const deploymentRetention = params.deploymentRetention;
        const scopes = params.scopes;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof name === 'undefined') {
            throw new BunwriteException('Missing required parameter: "name"');
        }
        if (typeof framework === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "framework"',
            );
        }
        const apiPath = '/sites/{siteId}'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
        );
        const apiPayload: Payload = {};
        if (typeof name !== 'undefined') {
            apiPayload['name'] = name;
        }
        if (typeof framework !== 'undefined') {
            apiPayload['framework'] = framework;
        }
        if (typeof enabled !== 'undefined') {
            apiPayload['enabled'] = enabled;
        }
        if (typeof logging !== 'undefined') {
            apiPayload['logging'] = logging;
        }
        if (typeof timeout !== 'undefined') {
            apiPayload['timeout'] = timeout;
        }
        if (typeof installCommand !== 'undefined') {
            apiPayload['installCommand'] = installCommand;
        }
        if (typeof buildCommand !== 'undefined') {
            apiPayload['buildCommand'] = buildCommand;
        }
        if (typeof startCommand !== 'undefined') {
            apiPayload['startCommand'] = startCommand;
        }
        if (typeof outputDirectory !== 'undefined') {
            apiPayload['outputDirectory'] = outputDirectory;
        }
        if (typeof buildRuntime !== 'undefined') {
            apiPayload['buildRuntime'] = buildRuntime;
        }
        if (typeof adapter !== 'undefined') {
            apiPayload['adapter'] = adapter;
        }
        if (typeof fallbackFile !== 'undefined') {
            apiPayload['fallbackFile'] = fallbackFile;
        }
        if (typeof apiFunctionId !== 'undefined') {
            apiPayload['apiFunctionId'] = apiFunctionId;
        }
        if (typeof domain !== 'undefined') {
            apiPayload['domain'] = domain;
        }
        if (typeof installationId !== 'undefined') {
            apiPayload['installationId'] = installationId;
        }
        if (typeof providerRepositoryId !== 'undefined') {
            apiPayload['providerRepositoryId'] = providerRepositoryId;
        }
        if (typeof providerBranch !== 'undefined') {
            apiPayload['providerBranch'] = providerBranch;
        }
        if (typeof providerSilentMode !== 'undefined') {
            apiPayload['providerSilentMode'] = providerSilentMode;
        }
        if (typeof providerRootDirectory !== 'undefined') {
            apiPayload['providerRootDirectory'] = providerRootDirectory;
        }
        if (typeof providerBranches !== 'undefined') {
            apiPayload['providerBranches'] = providerBranches;
        }
        if (typeof providerPaths !== 'undefined') {
            apiPayload['providerPaths'] = providerPaths;
        }
        if (typeof buildSpecification !== 'undefined') {
            apiPayload['buildSpecification'] = buildSpecification;
        }
        if (typeof runtimeSpecification !== 'undefined') {
            apiPayload['runtimeSpecification'] = runtimeSpecification;
        }
        if (typeof deploymentRetention !== 'undefined') {
            apiPayload['deploymentRetention'] = deploymentRetention;
        }
        if (typeof scopes !== 'undefined') {
            apiPayload['scopes'] = scopes;
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
     * Delete a site by its unique ID.
     *
     * @param {string} params.siteId - Site ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    delete(params: { siteId: string }): Promise<{}>;
    /**
     * Delete a site by its unique ID.
     *
     * @param {string} siteId - Site ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    delete(siteId: string): Promise<{}>;
    delete(paramsOrFirst: { siteId: string } | string): Promise<{}> {
        let params: { siteId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as { siteId: string };
        } else {
            params = {
                siteId: paramsOrFirst as string,
            };
        }

        const siteId = params.siteId;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        const apiPath = '/sites/{siteId}'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
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
     * Update the site active deployment. Use this endpoint to switch the code deployment that should be used when visitor opens your site.
     *
     * @param {string} params.siteId - Site ID.
     * @param {string} params.deploymentId - Deployment ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     */
    updateSiteDeployment(params: {
        siteId: string;
        deploymentId: string;
    }): Promise<Models.Site>;
    /**
     * Update the site active deployment. Use this endpoint to switch the code deployment that should be used when visitor opens your site.
     *
     * @param {string} siteId - Site ID.
     * @param {string} deploymentId - Deployment ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Site>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    updateSiteDeployment(
        siteId: string,
        deploymentId: string,
    ): Promise<Models.Site>;
    updateSiteDeployment(
        paramsOrFirst: { siteId: string; deploymentId: string } | string,
        ...rest: [string?]
    ): Promise<Models.Site> {
        let params: { siteId: string; deploymentId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                deploymentId: string;
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                deploymentId: rest[0] as string,
            };
        }

        const siteId = params.siteId;
        const deploymentId = params.deploymentId;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof deploymentId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "deploymentId"',
            );
        }
        const apiPath = '/sites/{siteId}/deployment'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
        );
        const apiPayload: Payload = {};
        if (typeof deploymentId !== 'undefined') {
            apiPayload['deploymentId'] = deploymentId;
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
     * Get a list of all the site's code deployments. You can use the query params to filter your results.
     *
     * @param {string} params.siteId - Site ID.
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: buildSize, sourceSize, totalSize, buildDuration, status, activate, type
     * @param {string} params.search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.DeploymentList>}
     */
    listDeployments(params: {
        siteId: string;
        queries?: string[];
        search?: string;
        total?: boolean;
    }): Promise<Models.DeploymentList>;
    /**
     * Get a list of all the site's code deployments. You can use the query params to filter your results.
     *
     * @param {string} siteId - Site ID.
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: buildSize, sourceSize, totalSize, buildDuration, status, activate, type
     * @param {string} search - Search term to filter your list results. Max length: 256 chars.
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.DeploymentList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listDeployments(
        siteId: string,
        queries?: string[],
        search?: string,
        total?: boolean,
    ): Promise<Models.DeploymentList>;
    listDeployments(
        paramsOrFirst:
            | {
                  siteId: string;
                  queries?: string[];
                  search?: string;
                  total?: boolean;
              }
            | string,
        ...rest: [string[]?, string?, boolean?]
    ): Promise<Models.DeploymentList> {
        let params: {
            siteId: string;
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
                siteId: string;
                queries?: string[];
                search?: string;
                total?: boolean;
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                queries: rest[0] as string[],
                search: rest[1] as string,
                total: rest[2] as boolean,
            };
        }

        const siteId = params.siteId;
        const queries = params.queries;
        const search = params.search;
        const total = params.total;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        const apiPath = '/sites/{siteId}/deployments'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
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
            'X-Bunwrite-Project': this.client.config.project,
            accept: 'application/json',
        };

        return this.client.call('get', uri, apiHeaders, apiPayload);
    }

    /**
     * Create a new site code deployment. Use this endpoint to upload a new version of your site code. To activate your newly uploaded code, you'll need to update the site's deployment to use your new deployment ID.
     *
     * @param {string} params.siteId - Site ID.
     * @param {File | InputFile} params.code - Gzip file with your code package. When used with the Bunwrite CLI, pass the path to your code directory, and the CLI will automatically package your code. Use a path that is within the current directory.
     * @param {string} params.installCommand - Install Commands.
     * @param {string} params.buildCommand - Build Commands.
     * @param {string} params.outputDirectory - Output Directory.
     * @param {boolean} params.activate - Automatically activate the deployment when it is finished building.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Deployment>}
     */
    createDeployment(params: {
        siteId: string;
        code: File | InputFile;
        installCommand?: string;
        buildCommand?: string;
        outputDirectory?: string;
        activate?: boolean;
        onProgress?: (progress: UploadProgress) => void;
    }): Promise<Models.Deployment>;
    /**
     * Create a new site code deployment. Use this endpoint to upload a new version of your site code. To activate your newly uploaded code, you'll need to update the site's deployment to use your new deployment ID.
     *
     * @param {string} siteId - Site ID.
     * @param {File | InputFile} code - Gzip file with your code package. When used with the Bunwrite CLI, pass the path to your code directory, and the CLI will automatically package your code. Use a path that is within the current directory.
     * @param {string} installCommand - Install Commands.
     * @param {string} buildCommand - Build Commands.
     * @param {string} outputDirectory - Output Directory.
     * @param {boolean} activate - Automatically activate the deployment when it is finished building.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Deployment>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    createDeployment(
        siteId: string,
        code: File | InputFile,
        installCommand?: string,
        buildCommand?: string,
        outputDirectory?: string,
        activate?: boolean,
        onProgress?: (progress: UploadProgress) => void,
    ): Promise<Models.Deployment>;
    createDeployment(
        paramsOrFirst:
            | {
                  siteId: string;
                  code: File | InputFile;
                  installCommand?: string;
                  buildCommand?: string;
                  outputDirectory?: string;
                  activate?: boolean;
                  onProgress?: (progress: UploadProgress) => void;
              }
            | string,
        ...rest: [
            (File | InputFile)?,
            string?,
            string?,
            string?,
            boolean?,
            ((progress: UploadProgress) => void)?,
        ]
    ): Promise<Models.Deployment> {
        let params: {
            siteId: string;
            code: File | InputFile;
            installCommand?: string;
            buildCommand?: string;
            outputDirectory?: string;
            activate?: boolean;
        };
        let onProgress: (progress: UploadProgress) => void;

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                code: File | InputFile;
                installCommand?: string;
                buildCommand?: string;
                outputDirectory?: string;
                activate?: boolean;
            };
            onProgress = paramsOrFirst?.onProgress as (
                progress: UploadProgress,
            ) => void;
        } else {
            params = {
                siteId: paramsOrFirst as string,
                code: rest[0] as File | InputFile,
                installCommand: rest[1] as string,
                buildCommand: rest[2] as string,
                outputDirectory: rest[3] as string,
                activate: rest[4] as boolean,
            };
            onProgress = rest[5] as (progress: UploadProgress) => void;
        }

        const siteId = params.siteId;
        const code = params.code;
        const installCommand = params.installCommand;
        const buildCommand = params.buildCommand;
        const outputDirectory = params.outputDirectory;
        const activate = params.activate;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof code === 'undefined') {
            throw new BunwriteException('Missing required parameter: "code"');
        }
        const apiPath = '/sites/{siteId}/deployments'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
        );
        const apiPayload: Payload = {};
        if (typeof installCommand !== 'undefined') {
            apiPayload['installCommand'] = installCommand;
        }
        if (typeof buildCommand !== 'undefined') {
            apiPayload['buildCommand'] = buildCommand;
        }
        if (typeof outputDirectory !== 'undefined') {
            apiPayload['outputDirectory'] = outputDirectory;
        }
        if (typeof code !== 'undefined') {
            apiPayload['code'] = code;
        }
        if (typeof activate !== 'undefined') {
            apiPayload['activate'] = activate;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            'content-type': 'multipart/form-data',
            accept: 'application/json',
        };

        return this.client.chunkedUpload(
            'post',
            uri,
            apiHeaders,
            apiPayload,
            onProgress,
        );
    }

    /**
     * Get a site deployment by its unique ID.
     *
     * @param {string} params.siteId - Site ID.
     * @param {string} params.deploymentId - Deployment ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Deployment>}
     */
    getDeployment(params: {
        siteId: string;
        deploymentId: string;
    }): Promise<Models.Deployment>;
    /**
     * Get a site deployment by its unique ID.
     *
     * @param {string} siteId - Site ID.
     * @param {string} deploymentId - Deployment ID.
     * @throws {BunwriteException}
     * @returns {Promise<Models.Deployment>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getDeployment(
        siteId: string,
        deploymentId: string,
    ): Promise<Models.Deployment>;
    getDeployment(
        paramsOrFirst: { siteId: string; deploymentId: string } | string,
        ...rest: [string?]
    ): Promise<Models.Deployment> {
        let params: { siteId: string; deploymentId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                deploymentId: string;
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                deploymentId: rest[0] as string,
            };
        }

        const siteId = params.siteId;
        const deploymentId = params.deploymentId;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof deploymentId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "deploymentId"',
            );
        }
        const apiPath = '/sites/{siteId}/deployments/{deploymentId}'
            .replace('{siteId}', encodeURIComponent(String(siteId)))
            .replace(
                '{deploymentId}',
                encodeURIComponent(String(deploymentId)),
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
     * Delete a site deployment by its unique ID.
     *
     * @param {string} params.siteId - Site ID.
     * @param {string} params.deploymentId - Deployment ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     */
    deleteDeployment(params: {
        siteId: string;
        deploymentId: string;
    }): Promise<{}>;
    /**
     * Delete a site deployment by its unique ID.
     *
     * @param {string} siteId - Site ID.
     * @param {string} deploymentId - Deployment ID.
     * @throws {BunwriteException}
     * @returns {Promise<{}>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    deleteDeployment(siteId: string, deploymentId: string): Promise<{}>;
    deleteDeployment(
        paramsOrFirst: { siteId: string; deploymentId: string } | string,
        ...rest: [string?]
    ): Promise<{}> {
        let params: { siteId: string; deploymentId: string };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                deploymentId: string;
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                deploymentId: rest[0] as string,
            };
        }

        const siteId = params.siteId;
        const deploymentId = params.deploymentId;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof deploymentId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "deploymentId"',
            );
        }
        const apiPath = '/sites/{siteId}/deployments/{deploymentId}'
            .replace('{siteId}', encodeURIComponent(String(siteId)))
            .replace(
                '{deploymentId}',
                encodeURIComponent(String(deploymentId)),
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
     * Get a site deployment content by its unique ID. The endpoint response return with a 'Content-Disposition: attachment' header that tells the browser to start downloading the file to user downloads directory.
     *
     * @param {string} params.siteId - Site ID.
     * @param {string} params.deploymentId - Deployment ID.
     * @param {DeploymentDownloadType} params.type - Deployment file to download. Can be: "source", "output".
     * @param {string} params.token - Presigned source-download token for accessing this deployment without a session (jobs-service).
     * @throws {BunwriteException}
     * @returns {Promise<ArrayBuffer>}
     */
    getDeploymentDownload(params: {
        siteId: string;
        deploymentId: string;
        type?: DeploymentDownloadType;
        token?: string;
    }): Promise<ArrayBuffer>;
    /**
     * Get a site deployment content by its unique ID. The endpoint response return with a 'Content-Disposition: attachment' header that tells the browser to start downloading the file to user downloads directory.
     *
     * @param {string} siteId - Site ID.
     * @param {string} deploymentId - Deployment ID.
     * @param {DeploymentDownloadType} type - Deployment file to download. Can be: "source", "output".
     * @param {string} token - Presigned source-download token for accessing this deployment without a session (jobs-service).
     * @throws {BunwriteException}
     * @returns {Promise<ArrayBuffer>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    getDeploymentDownload(
        siteId: string,
        deploymentId: string,
        type?: DeploymentDownloadType,
        token?: string,
    ): Promise<ArrayBuffer>;
    getDeploymentDownload(
        paramsOrFirst:
            | {
                  siteId: string;
                  deploymentId: string;
                  type?: DeploymentDownloadType;
                  token?: string;
              }
            | string,
        ...rest: [string?, DeploymentDownloadType?, string?]
    ): Promise<ArrayBuffer> {
        let params: {
            siteId: string;
            deploymentId: string;
            type?: DeploymentDownloadType;
            token?: string;
        };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                deploymentId: string;
                type?: DeploymentDownloadType;
                token?: string;
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                deploymentId: rest[0] as string,
                type: rest[1] as DeploymentDownloadType,
                token: rest[2] as string,
            };
        }

        const siteId = params.siteId;
        const deploymentId = params.deploymentId;
        const type = params.type;
        const token = params.token;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        if (typeof deploymentId === 'undefined') {
            throw new BunwriteException(
                'Missing required parameter: "deploymentId"',
            );
        }
        const apiPath = '/sites/{siteId}/deployments/{deploymentId}/download'
            .replace('{siteId}', encodeURIComponent(String(siteId)))
            .replace(
                '{deploymentId}',
                encodeURIComponent(String(deploymentId)),
            );
        const apiPayload: Payload = {};
        if (typeof type !== 'undefined') {
            apiPayload['type'] = type;
        }
        if (typeof token !== 'undefined') {
            apiPayload['token'] = token;
        }
        const uri = new URL(this.client.config.endpoint + apiPath);

        const apiHeaders: { [header: string]: string } = {
            'X-Bunwrite-Project': this.client.config.project,
            accept: '*/*',
        };

        return this.client.call(
            'get',
            uri,
            apiHeaders,
            apiPayload,
            'arrayBuffer',
        );
    }

    /**
     * Get a list of all variables of a specific site.
     *
     * @param {string} params.siteId - Site unique ID.
     * @param {string[]} params.queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: key, resourceType, resourceId, secret
     * @param {boolean} params.total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.VariableList>}
     */
    listVariables(params: {
        siteId: string;
        queries?: string[];
        total?: boolean;
    }): Promise<Models.VariableList>;
    /**
     * Get a list of all variables of a specific site.
     *
     * @param {string} siteId - Site unique ID.
     * @param {string[]} queries - Array of query strings generated using the Query class provided by the SDK. [Learn more about queries](https://appwrite.io/docs/queries). Maximum of 100 queries are allowed, each 4096 characters long. You may filter on the following attributes: key, resourceType, resourceId, secret
     * @param {boolean} total - When set to false, the total count returned will be 0 and will not be calculated.
     * @throws {BunwriteException}
     * @returns {Promise<Models.VariableList>}
     * @deprecated Use the object parameter style method for a better developer experience.
     */
    listVariables(
        siteId: string,
        queries?: string[],
        total?: boolean,
    ): Promise<Models.VariableList>;
    listVariables(
        paramsOrFirst:
            { siteId: string; queries?: string[]; total?: boolean } | string,
        ...rest: [string[]?, boolean?]
    ): Promise<Models.VariableList> {
        let params: { siteId: string; queries?: string[]; total?: boolean };

        if (
            paramsOrFirst &&
            typeof paramsOrFirst === 'object' &&
            !Array.isArray(paramsOrFirst)
        ) {
            params = (paramsOrFirst || {}) as {
                siteId: string;
                queries?: string[];
                total?: boolean;
            };
        } else {
            params = {
                siteId: paramsOrFirst as string,
                queries: rest[0] as string[],
                total: rest[1] as boolean,
            };
        }

        const siteId = params.siteId;
        const queries = params.queries;
        const total = params.total;
        if (typeof siteId === 'undefined') {
            throw new BunwriteException('Missing required parameter: "siteId"');
        }
        const apiPath = '/sites/{siteId}/variables'.replace(
            '{siteId}',
            encodeURIComponent(String(siteId)),
        );
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
}
