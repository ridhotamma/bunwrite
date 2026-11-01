/**
 * The internal tool catalog. The model never sees all of these at once: it
 * searches the catalog through `bunwrite_search_tools` and runs one operation
 * at a time. Operations map to the Bunwrite SDK, so paths, payloads and Appwrite
 * compatibility stay in one place.
 */
import {
  type Client,
  Databases,
  Functions,
  Health,
  Messaging,
  Sites,
  Storage,
  Teams,
  Users,
} from '@bunwrite/sdk'

import type { McpConfig } from './config'

export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type OperationArgs = Record<string, any>

export interface Services {
  client: Client
  config: McpConfig
  databases: Databases
  users: Users
  teams: Teams
  storage: Storage
  functions: Functions
  sites: Sites
  messaging: Messaging
  health: Health
}

export interface Operation {
  /** Stable identifier used by `bunwrite_call_tool`. */
  name: string
  title: string
  description: string
  group: string
  /** Changes project state. Only reachable through the confirmed write tool. */
  write?: boolean
  /** Deletes data or has other irreversible effects. */
  destructive?: boolean
  input: JsonSchema
  run: (services: Services, args: OperationArgs) => Promise<unknown>
}

export function createServices(client: Client, config: McpConfig): Services {
  return {
    client,
    config,
    databases: new Databases(client),
    users: new Users(client),
    teams: new Teams(client),
    storage: new Storage(client),
    functions: new Functions(client),
    sites: new Sites(client),
    messaging: new Messaging(client),
    health: new Health(client),
  }
}

const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

const string = (description: string) => ({ type: 'string', description })
const boolean = (description: string) => ({ type: 'boolean', description })
const integer = (description: string) => ({ type: 'integer', description })
const number = (description: string) => ({ type: 'number', description })
const stringList = (description: string) => ({ type: 'array', description, items: { type: 'string' } })
const objectField = (description: string) => ({ type: 'object', description, additionalProperties: true })

const DATABASE = string('Database ID.')
const COLLECTION = string('Collection ID.')
const DOCUMENT = string('Document ID.')
const QUERIES = stringList(
  'Appwrite query strings as JSON. Examples: ["{\\"method\\":\\"limit\\",\\"values\\":[25]}", "{\\"method\\":\\"orderDesc\\",\\"attribute\\":\\"$createdAt\\"}"].',
)
const SEARCH = string('Optional search term.')
const PERMISSIONS = stringList('Permission strings, for example ["read(\"users\")", "create(\"users\")"].')

const op = (operation: Operation): Operation => operation

export const CATALOG: Operation[] = [
  // ---------------------------------------------------------------- health
  op({
    name: 'health_get',
    title: 'Get service health',
    description: 'Ping the Bunwrite HTTP service and return its health payload.',
    group: 'health',
    input: object({}),
    run: (services) => services.health.get(),
  }),
  op({
    name: 'health_version',
    title: 'Get Bunwrite version',
    description: 'Return the Bunwrite server version.',
    group: 'health',
    input: object({}),
    run: (services) => services.health.getVersion(),
  }),

  // ------------------------------------------------------------- databases
  op({
    name: 'databases_list',
    title: 'List databases',
    description: 'List the databases in the project, with pagination and search through Appwrite queries.',
    group: 'databases',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.databases.list({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'databases_get',
    title: 'Get a database',
    description: 'Get one database by ID, including its collections count and metadata.',
    group: 'databases',
    input: object({ databaseId: DATABASE }, ['databaseId']),
    run: (services, args) => services.databases.get({ databaseId: args.databaseId }),
  }),
  op({
    name: 'databases_create',
    title: 'Create a database',
    description: 'Create a database. An API key can create databases; a user session usually cannot.',
    group: 'databases',
    write: true,
    input: object({ databaseId: DATABASE, name: string('Database name.'), enabled: boolean('Whether the database is enabled.') }, ['databaseId', 'name']),
    run: (services, args) =>
      services.databases.create({ databaseId: args.databaseId, name: args.name, enabled: args.enabled }),
  }),
  op({
    name: 'databases_delete',
    title: 'Delete a database',
    description: 'Delete a database and every collection and document in it. This cannot be undone.',
    group: 'databases',
    write: true,
    destructive: true,
    input: object({ databaseId: DATABASE }, ['databaseId']),
    run: (services, args) => services.databases.delete({ databaseId: args.databaseId }),
  }),

  op({
    name: 'collections_list',
    title: 'List collections',
    description: 'List collections in a database, with queries and search.',
    group: 'databases',
    input: object({ databaseId: DATABASE, queries: QUERIES, search: SEARCH }, ['databaseId']),
    run: (services, args) =>
      services.databases.listCollections({ databaseId: args.databaseId, queries: args.queries, search: args.search }),
  }),
  op({
    name: 'collections_get',
    title: 'Get a collection',
    description: 'Get a collection schema: attributes, indexes, permissions and settings.',
    group: 'databases',
    input: object({ databaseId: DATABASE, collectionId: COLLECTION }, ['databaseId', 'collectionId']),
    run: (services, args) =>
      services.databases.getCollection({ databaseId: args.databaseId, collectionId: args.collectionId }),
  }),
  op({
    name: 'collections_create',
    title: 'Create a collection',
    description: 'Create a collection in a database.',
    group: 'databases',
    write: true,
    input: object(
      {
        databaseId: DATABASE,
        collectionId: COLLECTION,
        name: string('Collection name.'),
        permissions: PERMISSIONS,
        documentSecurity: boolean('Evaluate permissions per document.'),
        enabled: boolean('Whether the collection is enabled.'),
      },
      ['databaseId', 'collectionId', 'name'],
    ),
    run: (services, args) =>
      services.databases.createCollection({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        name: args.name,
        permissions: args.permissions,
        documentSecurity: args.documentSecurity,
        enabled: args.enabled,
      }),
  }),
  op({
    name: 'collections_delete',
    title: 'Delete a collection',
    description: 'Delete a collection and all of its documents. This cannot be undone.',
    group: 'databases',
    write: true,
    destructive: true,
    input: object({ databaseId: DATABASE, collectionId: COLLECTION }, ['databaseId', 'collectionId']),
    run: (services, args) =>
      services.databases.deleteCollection({ databaseId: args.databaseId, collectionId: args.collectionId }),
  }),

  op({
    name: 'attributes_list',
    title: 'List attributes',
    description: 'List the attributes (columns) of a collection.',
    group: 'databases',
    input: object({ databaseId: DATABASE, collectionId: COLLECTION }, ['databaseId', 'collectionId']),
    run: (services, args) =>
      services.databases.listAttributes({ databaseId: args.databaseId, collectionId: args.collectionId }),
  }),
  op({
    name: 'attributes_create',
    title: 'Create an attribute',
    description:
      'Add an attribute to a collection. Pick a type and pass its fields: string (size), integer/float (min, max), boolean, datetime, email, url, ip or enum (elements). Use default for the default value.',
    group: 'databases',
    write: true,
    input: object(
      {
        databaseId: DATABASE,
        collectionId: COLLECTION,
        key: string('Attribute key.'),
        type: {
          type: 'string',
          enum: ['string', 'integer', 'float', 'boolean', 'datetime', 'email', 'url', 'ip', 'enum'],
          description: 'Attribute type.',
        },
        required: boolean('Whether every document must contain the attribute.'),
        array: boolean('Store an array of values.'),
        size: integer('String size, for type string.'),
        min: number('Minimum for integer/float.'),
        max: number('Maximum for integer/float.'),
        default: { description: 'Default value; a string, number or boolean matching the type.' },
        elements: stringList('Allowed values for type enum.'),
      },
      ['databaseId', 'collectionId', 'key', 'type', 'required'],
    ),
    run: (services, args) => {
      const common = {
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        key: args.key,
        required: Boolean(args.required),
        array: Boolean(args.array),
      }
      switch (args.type) {
        case 'string':
          return services.databases.createStringAttribute({ ...common, size: args.size ?? 255, xdefault: args.default })
        case 'integer':
          return services.databases.createIntegerAttribute({ ...common, min: args.min, max: args.max, xdefault: args.default })
        case 'float':
          return services.databases.createFloatAttribute({ ...common, min: args.min, max: args.max, xdefault: args.default })
        case 'boolean':
          return services.databases.createBooleanAttribute({ ...common, xdefault: args.default })
        case 'datetime':
          return services.databases.createDatetimeAttribute({ ...common, xdefault: args.default })
        case 'email':
          return services.databases.createEmailAttribute({ ...common, xdefault: args.default })
        case 'url':
          return services.databases.createUrlAttribute({ ...common, xdefault: args.default })
        case 'ip':
          return services.databases.createIpAttribute({ ...common, xdefault: args.default })
        case 'enum':
          return services.databases.createEnumAttribute({ ...common, elements: args.elements, xdefault: args.default })
        default:
          throw new Error(`Unknown attribute type: ${args.type}`)
      }
    },
  }),
  op({
    name: 'attributes_delete',
    title: 'Delete an attribute',
    description: 'Delete an attribute from a collection. Existing document values for it are removed.',
    group: 'databases',
    write: true,
    destructive: true,
    input: object({ databaseId: DATABASE, collectionId: COLLECTION, key: string('Attribute key.') }, ['databaseId', 'collectionId', 'key']),
    run: (services, args) =>
      services.databases.deleteAttribute({ databaseId: args.databaseId, collectionId: args.collectionId, key: args.key }),
  }),

  op({
    name: 'indexes_list',
    title: 'List indexes',
    description: 'List the indexes of a collection.',
    group: 'databases',
    input: object({ databaseId: DATABASE, collectionId: COLLECTION }, ['databaseId', 'collectionId']),
    run: (services, args) =>
      services.databases.listIndexes({ databaseId: args.databaseId, collectionId: args.collectionId }),
  }),
  op({
    name: 'indexes_create',
    title: 'Create an index',
    description: 'Create a key, unique or fulltext index on one or more attributes.',
    group: 'databases',
    write: true,
    input: object(
      {
        databaseId: DATABASE,
        collectionId: COLLECTION,
        key: string('Index key.'),
        type: { type: 'string', enum: ['key', 'unique', 'fulltext'], description: 'Index type.' },
        attributes: stringList('Attributes in the index, in order.'),
        orders: stringList('Optional order per attribute: asc or desc.'),
        lengths: { type: 'array', description: 'Optional length per attribute for fulltext indexes.', items: { type: 'integer' } },
      },
      ['databaseId', 'collectionId', 'key', 'type', 'attributes'],
    ),
    run: (services, args) =>
      services.databases.createIndex({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        key: args.key,
        type: args.type,
        attributes: args.attributes,
        orders: args.orders,
        lengths: args.lengths,
      } as any),
  }),
  op({
    name: 'indexes_delete',
    title: 'Delete an index',
    description: 'Delete an index from a collection.',
    group: 'databases',
    write: true,
    destructive: true,
    input: object({ databaseId: DATABASE, collectionId: COLLECTION, key: string('Index key.') }, ['databaseId', 'collectionId', 'key']),
    run: (services, args) =>
      services.databases.deleteIndex({ databaseId: args.databaseId, collectionId: args.collectionId, key: args.key }),
  }),

  op({
    name: 'documents_list',
    title: 'List documents',
    description: 'List documents in a collection. Always pass a limit query for large collections.',
    group: 'databases',
    input: object({ databaseId: DATABASE, collectionId: COLLECTION, queries: QUERIES }, ['databaseId', 'collectionId']),
    run: (services, args) =>
      services.databases.listDocuments({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        queries: args.queries,
      }),
  }),
  op({
    name: 'documents_get',
    title: 'Get a document',
    description: 'Get one document by ID.',
    group: 'databases',
    input: object({ databaseId: DATABASE, collectionId: COLLECTION, documentId: DOCUMENT }, ['databaseId', 'collectionId', 'documentId']),
    run: (services, args) =>
      services.databases.getDocument({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        documentId: args.documentId,
      }),
  }),
  op({
    name: 'documents_create',
    title: 'Create a document',
    description: 'Create a document. The data object must match the collection attributes.',
    group: 'databases',
    write: true,
    input: object(
      {
        databaseId: DATABASE,
        collectionId: COLLECTION,
        documentId: DOCUMENT,
        data: objectField('Document fields, keyed by attribute.'),
        permissions: PERMISSIONS,
      },
      ['databaseId', 'collectionId', 'documentId', 'data'],
    ),
    run: (services, args) =>
      services.databases.createDocument({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        documentId: args.documentId,
        data: args.data,
        permissions: args.permissions,
      }),
  }),
  op({
    name: 'documents_update',
    title: 'Update a document',
    description: 'Update some fields of a document. Omit a field to leave it unchanged.',
    group: 'databases',
    write: true,
    input: object(
      {
        databaseId: DATABASE,
        collectionId: COLLECTION,
        documentId: DOCUMENT,
        data: objectField('Fields to change.'),
        permissions: PERMISSIONS,
      },
      ['databaseId', 'collectionId', 'documentId', 'data'],
    ),
    run: (services, args) =>
      services.databases.updateDocument({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        documentId: args.documentId,
        data: args.data,
        permissions: args.permissions,
      }),
  }),
  op({
    name: 'documents_delete',
    title: 'Delete a document',
    description: 'Delete one document. This cannot be undone.',
    group: 'databases',
    write: true,
    destructive: true,
    input: object({ databaseId: DATABASE, collectionId: COLLECTION, documentId: DOCUMENT }, ['databaseId', 'collectionId', 'documentId']),
    run: (services, args) =>
      services.databases.deleteDocument({
        databaseId: args.databaseId,
        collectionId: args.collectionId,
        documentId: args.documentId,
      }),
  }),

  // ----------------------------------------------------------------- users
  op({
    name: 'users_list',
    title: 'List users',
    description: 'List project users, with queries and search.',
    group: 'users',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.users.list({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'users_get',
    title: 'Get a user',
    description: 'Get one user by ID.',
    group: 'users',
    input: object({ userId: string('User ID.') }, ['userId']),
    run: (services, args) => services.users.get({ userId: args.userId }),
  }),
  op({
    name: 'users_create',
    title: 'Create a user',
    description: 'Create a user. Provide an email, a phone or both, plus an optional password and name.',
    group: 'users',
    write: true,
    input: object(
      {
        userId: string('User ID.'),
        email: string('Email address.'),
        phone: string('Phone number in E.164 format.'),
        password: string('Initial password.'),
        name: string('Display name.'),
      },
      ['userId'],
    ),
    run: (services, args) =>
      services.users.create({
        userId: args.userId,
        email: args.email,
        phone: args.phone,
        password: args.password,
        name: args.name,
      }),
  }),
  op({
    name: 'users_update_email',
    title: 'Update a user email',
    description: 'Change a user email address.',
    group: 'users',
    write: true,
    input: object({ userId: string('User ID.'), email: string('New email address.') }, ['userId', 'email']),
    run: (services, args) => services.users.updateEmail({ userId: args.userId, email: args.email }),
  }),
  op({
    name: 'users_update_name',
    title: 'Update a user name',
    description: 'Change a user display name.',
    group: 'users',
    write: true,
    input: object({ userId: string('User ID.'), name: string('New display name.') }, ['userId', 'name']),
    run: (services, args) => services.users.updateName({ userId: args.userId, name: args.name }),
  }),
  op({
    name: 'users_update_status',
    title: 'Block or unblock a user',
    description: 'Set a user status. false blocks the account and ends its sessions.',
    group: 'users',
    write: true,
    input: object({ userId: string('User ID.'), status: boolean('true to unblock, false to block.') }, ['userId', 'status']),
    run: (services, args) => services.users.updateStatus({ userId: args.userId, status: args.status }),
  }),
  op({
    name: 'users_delete',
    title: 'Delete a user',
    description: 'Delete a user and release the ID. Delete their documents and files first. This cannot be undone.',
    group: 'users',
    write: true,
    destructive: true,
    input: object({ userId: string('User ID.') }, ['userId']),
    run: (services, args) => services.users.delete({ userId: args.userId }),
  }),
  op({
    name: 'users_list_sessions',
    title: 'List user sessions',
    description: 'List the active sessions of a user.',
    group: 'users',
    input: object({ userId: string('User ID.') }, ['userId']),
    run: (services, args) => services.users.listSessions({ userId: args.userId }),
  }),
  op({
    name: 'users_delete_session',
    title: 'Delete a user session',
    description: 'End one session of a user immediately.',
    group: 'users',
    write: true,
    destructive: true,
    input: object({ userId: string('User ID.'), sessionId: string('Session ID or current.') }, ['userId', 'sessionId']),
    run: (services, args) => services.users.deleteSession({ userId: args.userId, sessionId: args.sessionId }),
  }),

  // ----------------------------------------------------------------- teams
  op({
    name: 'teams_list',
    title: 'List teams',
    description: 'List teams in the project.',
    group: 'teams',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.teams.list({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'teams_get',
    title: 'Get a team',
    description: 'Get one team by ID.',
    group: 'teams',
    input: object({ teamId: string('Team ID.') }, ['teamId']),
    run: (services, args) => services.teams.get({ teamId: args.teamId }),
  }),
  op({
    name: 'teams_create',
    title: 'Create a team',
    description: 'Create a team and optionally seed roles.',
    group: 'teams',
    write: true,
    input: object({ teamId: string('Team ID.'), name: string('Team name.'), roles: stringList('Optional initial roles.') }, ['teamId', 'name']),
    run: (services, args) => services.teams.create({ teamId: args.teamId, name: args.name, roles: args.roles }),
  }),
  op({
    name: 'teams_delete',
    title: 'Delete a team',
    description: 'Delete a team and its memberships. This cannot be undone.',
    group: 'teams',
    write: true,
    destructive: true,
    input: object({ teamId: string('Team ID.') }, ['teamId']),
    run: (services, args) => services.teams.delete({ teamId: args.teamId }),
  }),
  op({
    name: 'teams_memberships_list',
    title: 'List team memberships',
    description: 'List the members of a team.',
    group: 'teams',
    input: object({ teamId: string('Team ID.'), queries: QUERIES, search: SEARCH }, ['teamId']),
    run: (services, args) =>
      services.teams.listMemberships({ teamId: args.teamId, queries: args.queries, search: args.search }),
  }),
  op({
    name: 'teams_memberships_create',
    title: 'Add a team member',
    description: 'Add an existing user by ID, or invite an email/phone. Server-side keys add the member immediately.',
    group: 'teams',
    write: true,
    input: object(
      {
        teamId: string('Team ID.'),
        roles: stringList('Roles to grant.'),
        userId: string('Existing user ID.'),
        email: string('Email to invite.'),
        phone: string('Phone to invite.'),
        name: string('Invitee name.'),
        url: string('Redirect URL after accepting the invite.'),
      },
      ['teamId', 'roles'],
    ),
    run: (services, args) =>
      services.teams.createMembership({
        teamId: args.teamId,
        roles: args.roles,
        userId: args.userId,
        email: args.email,
        phone: args.phone,
        name: args.name,
        url: args.url,
      }),
  }),
  op({
    name: 'teams_memberships_delete',
    title: 'Remove a team member',
    description: 'Remove a membership from a team.',
    group: 'teams',
    write: true,
    destructive: true,
    input: object({ teamId: string('Team ID.'), membershipId: string('Membership ID.') }, ['teamId', 'membershipId']),
    run: (services, args) =>
      services.teams.deleteMembership({ teamId: args.teamId, membershipId: args.membershipId }),
  }),

  // --------------------------------------------------------------- storage
  op({
    name: 'storage_buckets_list',
    title: 'List buckets',
    description: 'List storage buckets.',
    group: 'storage',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.storage.listBuckets({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'storage_buckets_get',
    title: 'Get a bucket',
    description: 'Get one bucket and its rules.',
    group: 'storage',
    input: object({ bucketId: string('Bucket ID.') }, ['bucketId']),
    run: (services, args) => services.storage.getBucket({ bucketId: args.bucketId }),
  }),
  op({
    name: 'storage_buckets_create',
    title: 'Create a bucket',
    description: 'Create a storage bucket with optional limits and permissions.',
    group: 'storage',
    write: true,
    input: object(
      {
        bucketId: string('Bucket ID.'),
        name: string('Bucket name.'),
        permissions: PERMISSIONS,
        fileSecurity: boolean('Evaluate permissions per file.'),
        enabled: boolean('Whether the bucket is enabled.'),
        maximumFileSize: integer('Maximum file size in bytes.'),
        allowedFileExtensions: stringList('Allowed extensions without dots, for example ["png","jpg"].'),
        compression: string('gzip, zstd or none.'),
        encryption: boolean('Encrypt files at rest.'),
        antivirus: boolean('Scan uploads for malware.'),
      },
      ['bucketId', 'name'],
    ),
    run: (services, args) =>
      services.storage.createBucket({
        bucketId: args.bucketId,
        name: args.name,
        permissions: args.permissions,
        fileSecurity: args.fileSecurity,
        enabled: args.enabled,
        maximumFileSize: args.maximumFileSize,
        allowedFileExtensions: args.allowedFileExtensions,
        compression: args.compression,
        encryption: args.encryption,
        antivirus: args.antivirus,
      }),
  }),
  op({
    name: 'storage_buckets_delete',
    title: 'Delete a bucket',
    description: 'Delete a bucket and its files. This cannot be undone.',
    group: 'storage',
    write: true,
    destructive: true,
    input: object({ bucketId: string('Bucket ID.') }, ['bucketId']),
    run: (services, args) => services.storage.deleteBucket({ bucketId: args.bucketId }),
  }),
  op({
    name: 'storage_files_list',
    title: 'List files',
    description: 'List files in a bucket.',
    group: 'storage',
    input: object({ bucketId: string('Bucket ID.'), queries: QUERIES, search: SEARCH }, ['bucketId']),
    run: (services, args) =>
      services.storage.listFiles({ bucketId: args.bucketId, queries: args.queries, search: args.search }),
  }),
  op({
    name: 'storage_files_get',
    title: 'Get file metadata',
    description: 'Get one file record: name, MIME type, size, permissions and URLs.',
    group: 'storage',
    input: object({ bucketId: string('Bucket ID.'), fileId: string('File ID.') }, ['bucketId', 'fileId']),
    run: (services, args) => services.storage.getFile({ bucketId: args.bucketId, fileId: args.fileId }),
  }),
  op({
    name: 'storage_files_create',
    title: 'Upload a file',
    description: 'Upload a file from base64 content. Keep contentBase64 under a few megabytes.',
    group: 'storage',
    write: true,
    input: object(
      {
        bucketId: string('Bucket ID.'),
        fileId: string('File ID.'),
        name: string('File name including extension.'),
        mimeType: string('MIME type, for example text/plain or image/png.'),
        contentBase64: string('File bytes encoded as base64.'),
        permissions: PERMISSIONS,
      },
      ['bucketId', 'fileId', 'name', 'mimeType', 'contentBase64'],
    ),
    run: (services, args) => {
      const bytes = Uint8Array.from(Buffer.from(String(args.contentBase64), 'base64'))
      const file = new File([bytes], String(args.name), { type: String(args.mimeType) })
      return services.storage.createFile({
        bucketId: args.bucketId,
        fileId: args.fileId,
        file,
        permissions: args.permissions,
      })
    },
  }),
  op({
    name: 'storage_files_delete',
    title: 'Delete a file',
    description: 'Delete a file from a bucket. This cannot be undone.',
    group: 'storage',
    write: true,
    destructive: true,
    input: object({ bucketId: string('Bucket ID.'), fileId: string('File ID.') }, ['bucketId', 'fileId']),
    run: (services, args) => services.storage.deleteFile({ bucketId: args.bucketId, fileId: args.fileId }),
  }),
  op({
    name: 'storage_files_download',
    title: 'Download a file',
    description: 'Return file content as base64. Requests larger than maxBytes fail instead of flooding the context.',
    group: 'storage',
    input: object(
      {
        bucketId: string('Bucket ID.'),
        fileId: string('File ID.'),
        maxBytes: integer('Maximum size to return; defaults to 1048576.'),
      },
      ['bucketId', 'fileId'],
    ),
    run: async (services, args) => {
      const limit = Number(args.maxBytes ?? 1_048_576)
      const buffer = await services.storage.getFileDownloadBytes({ bucketId: args.bucketId, fileId: args.fileId })
      if (buffer.byteLength > limit) throw new Error(`File is ${buffer.byteLength} bytes, above the ${limit} byte limit.`)
      const metadata = await services.storage.getFile({ bucketId: args.bucketId, fileId: args.fileId })
      return { name: metadata.name, mimeType: metadata.mimeType, size: metadata.sizeOriginal, base64: Buffer.from(buffer).toString('base64') }
    },
  }),

  // ------------------------------------------------------------- functions
  op({
    name: 'functions_list',
    title: 'List functions',
    description: 'List functions in the project.',
    group: 'functions',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.functions.list({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'functions_get',
    title: 'Get a function',
    description: 'Get one function, including its runtime, entrypoint, schedule and variables.',
    group: 'functions',
    input: object({ functionId: string('Function ID.') }, ['functionId']),
    run: (services, args) => services.functions.get({ functionId: args.functionId }),
  }),
  op({
    name: 'functions_executions_list',
    title: 'List function executions',
    description: 'List recent executions of a function, newest first by default.',
    group: 'functions',
    input: object({ functionId: string('Function ID.'), queries: QUERIES }, ['functionId']),
    run: (services, args) =>
      services.functions.listExecutions({ functionId: args.functionId, queries: args.queries }),
  }),
  op({
    name: 'functions_executions_get',
    title: 'Get a function execution',
    description: 'Get one execution, including status, response and errors.',
    group: 'functions',
    input: object({ functionId: string('Function ID.'), executionId: string('Execution ID.') }, ['functionId', 'executionId']),
    run: (services, args) =>
      services.functions.getExecution({ functionId: args.functionId, executionId: args.executionId }),
  }),
  op({
    name: 'functions_executions_create',
    title: 'Run a function',
    description: 'Trigger a function execution. Runs code and may have external side effects.',
    group: 'functions',
    write: true,
    input: object(
      {
        functionId: string('Function ID.'),
        body: string('HTTP body for the invocation.'),
        async: boolean('Run in the background.'),
        path: string('Request path passed to the function.'),
        method: string('HTTP method passed to the function.'),
        headers: objectField('Headers passed to the function.'),
      },
      ['functionId'],
    ),
    run: (services, args) =>
      services.functions.createExecution({
        functionId: args.functionId,
        body: args.body,
        async: args.async,
        xpath: args.path,
        method: args.method,
        headers: args.headers,
      } as any),
  }),

  // ----------------------------------------------------------------- sites
  op({
    name: 'sites_list',
    title: 'List sites',
    description: 'List static sites in the project.',
    group: 'sites',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.sites.list({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'sites_get',
    title: 'Get a site',
    description: 'Get one site, including its framework, build settings and live deployment.',
    group: 'sites',
    input: object({ siteId: string('Site ID.') }, ['siteId']),
    run: (services, args) => services.sites.get({ siteId: args.siteId }),
  }),
  op({
    name: 'sites_deployments_list',
    title: 'List site deployments',
    description: 'List deployments of a site.',
    group: 'sites',
    input: object({ siteId: string('Site ID.'), queries: QUERIES }, ['siteId']),
    run: (services, args) => services.sites.listDeployments({ siteId: args.siteId, queries: args.queries }),
  }),
  op({
    name: 'sites_deployments_get',
    title: 'Get a site deployment',
    description: 'Get one deployment, including status, logs and the build output location.',
    group: 'sites',
    input: object({ siteId: string('Site ID.'), deploymentId: string('Deployment ID.') }, ['siteId', 'deploymentId']),
    run: (services, args) => services.sites.getDeployment({ siteId: args.siteId, deploymentId: args.deploymentId }),
  }),

  // ------------------------------------------------------------- messaging
  op({
    name: 'topics_list',
    title: 'List topics',
    description: 'List messaging topics.',
    group: 'messaging',
    input: object({ queries: QUERIES, search: SEARCH }),
    run: (services, args) => services.messaging.listTopics({ queries: args.queries, search: args.search }),
  }),
  op({
    name: 'topics_get',
    title: 'Get a topic',
    description: 'Get one messaging topic.',
    group: 'messaging',
    input: object({ topicId: string('Topic ID.') }, ['topicId']),
    run: (services, args) => services.messaging.getTopic({ topicId: args.topicId }),
  }),
  op({
    name: 'topics_create',
    title: 'Create a topic',
    description: 'Create a messaging topic.',
    group: 'messaging',
    write: true,
    input: object(
      {
        topicId: string('Topic ID.'),
        name: string('Topic name.'),
        subscribe: stringList('Roles allowed to subscribe, for example ["users"].'),
      },
      ['topicId', 'name'],
    ),
    run: (services, args) =>
      services.messaging.createTopic({ topicId: args.topicId, name: args.name, subscribe: args.subscribe } as any),
  }),
  op({
    name: 'topics_delete',
    title: 'Delete a topic',
    description: 'Delete a messaging topic. This cannot be undone.',
    group: 'messaging',
    write: true,
    destructive: true,
    input: object({ topicId: string('Topic ID.') }, ['topicId']),
    run: (services, args) => services.messaging.deleteTopic({ topicId: args.topicId }),
  }),

  // ------------------------------------------------------------ observability
  op({
    name: 'flags_get',
    title: 'Get feature flags',
    description: 'Return the feature flags evaluated for this API key (project:<id>), including local FEATURE_FLAGS overrides.',
    group: 'flags',
    input: object({}),
    run: async (services) => {
      const response = await fetch(`${services.config.endpoint}/flags`, {
        headers: {
          'X-Bunwrite-Project': services.config.project,
          'X-Bunwrite-Key': services.config.key,
          accept: 'application/json',
        },
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`Flags request failed with ${response.status}: ${body.slice(0, 300)}`)
      return JSON.parse(body)
    },
  }),
]

export function findOperation(name: string): Operation | undefined {
  return CATALOG.find((operation) => operation.name === name)
}

export function operationGroups(): string[] {
  return [...new Set(CATALOG.map((operation) => operation.group))].sort()
}
