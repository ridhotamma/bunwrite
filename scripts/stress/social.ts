/**
 * Social-media stress test for a running Bunwrite instance.
 *
 * It creates an isolated `social_stress` database, seeds profiles, posts,
 * comments, likes, comment likes, reposts and follows, then measures the reads
 * and writes a social user generates: home feed, following feed, trending,
 * post detail, comments, profile, profile posts, search, create post, like,
 * comment, comment like, repost and follow (plus the counter increments those
 * actions trigger).
 *
 * Examples:
 *   export STRESS_API_KEY=...
 *   bun run stress:social setup \
 *     --base https://bunwrite.example.com/v1 --project social-media-app \
 *     --prefix soc-20261030
 *   bun run stress:social run --manifest data/stress/social-soc-20261030.json
 *   bun run stress:social mix --manifest data/stress/social-soc-20261030.json
 *
 * This is a development tool. Use it against a disposable project, never
 * production data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  api,
  assertId,
  assertOk,
  createCli,
  env,
  escapeRegex,
  iso,
  normalizeBase,
  pad,
  queryString,
  randomId,
  required,
  type ApiOptions,
} from './lib'
import { runMatrix, type RunResult, type Target } from './run'

const DEFAULT_DATABASE = 'social_stress'
const DEFAULT_PREFIX = `soc-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 12)}`
const DEFAULT_PROFILES = 1000
const DEFAULT_POSTS = 10_000
const DEFAULT_COMMENTS = 20_000
const DEFAULT_POST_LIKES = 30_000
const DEFAULT_COMMENT_LIKES = 10_000
const DEFAULT_REPOSTS = 5_000
const DEFAULT_FOLLOWS = 10_000
const DEFAULT_BATCH = 250
const DEFAULT_CONCURRENCY = '1,10,50,100'
const DEFAULT_WRITE_CONCURRENCY = '1,5,10,25'
const DEFAULT_DURATION = 10
const DEFAULT_WARMUP = 2
const DEFAULT_TIMEOUT = 15
const DEFAULT_MIX_CONCURRENCY = '50,100,200'
const DEFAULT_MIX_DURATION = 20
const DEFAULT_MIX_WARMUP = 5
const CALLS_PER_USER_MINUTE = 20
const SESSION_USER_ID = 'stress-social-user'
const SESSION_EMAIL = 'stress-social@example.com'
const SESSION_PASSWORD = 'stress-social-password-123'
const HOT = 100

const argv = process.argv.slice(2)
const command = argv[0] ?? 'all'
if (command === '--help' || command === '-h' || command === 'help') {
  usage()
  process.exit(0)
}
if (!['setup', 'run', 'all', 'mix', 'session', 'cleanup'].includes(command)) {
  usage()
  process.exit(1)
}
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}

const { flag, numberFlag, integerFlag, levels, boolFlag } = createCli(argv)

const profileAttributes = [
  { key: 'userId', type: 'string', size: 36, required: true },
  { key: 'username', type: 'string', size: 60, required: true },
  { key: 'displayName', type: 'string', size: 80, required: true },
  { key: 'bio', type: 'string', size: 300, required: false },
  { key: 'avatarUrl', type: 'string', size: 500, required: false },
  { key: 'followerCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'followingCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'postCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'verified', type: 'boolean', required: true },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
]

const postAttributes = [
  { key: 'authorId', type: 'string', size: 36, required: true },
  { key: 'authorUsername', type: 'string', size: 60, required: true },
  { key: 'content', type: 'string', size: 2000, required: true },
  { key: 'mediaUrl', type: 'string', size: 500, required: false },
  { key: 'likeCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'commentCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'repostCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'visibility', type: 'enum', required: true, elements: ['public', 'followers', 'private'] },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
  { key: 'repostOfId', type: 'string', size: 36, required: false },
]

const commentAttributes = [
  { key: 'postId', type: 'string', size: 36, required: true },
  { key: 'authorId', type: 'string', size: 36, required: true },
  { key: 'authorUsername', type: 'string', size: 60, required: true },
  { key: 'content', type: 'string', size: 2000, required: true },
  { key: 'likeCount', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'parentId', type: 'string', size: 36, required: false },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
]

const postLikeAttributes = [
  { key: 'userId', type: 'string', size: 36, required: true },
  { key: 'postId', type: 'string', size: 36, required: true },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
]

const commentLikeAttributes = [
  { key: 'userId', type: 'string', size: 36, required: true },
  { key: 'commentId', type: 'string', size: 36, required: true },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
]

const repostAttributes = [
  { key: 'userId', type: 'string', size: 36, required: true },
  { key: 'postId', type: 'string', size: 36, required: true },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
]

const followAttributes = [
  { key: 'followerId', type: 'string', size: 36, required: true },
  { key: 'followingId', type: 'string', size: 36, required: true },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
]

const collections = [
  {
    id: 'profiles',
    name: 'Profiles',
    attributes: profileAttributes,
    indexes: [
      { key: 'idx_profiles_username', type: 'unique', columns: ['username'], orders: ['ASC'] },
      { key: 'idx_profiles_followers', type: 'key', columns: ['followerCount'], orders: ['DESC'] },
    ],
  },
  {
    id: 'posts',
    name: 'Posts',
    attributes: postAttributes,
    indexes: [
      { key: 'idx_posts_created', type: 'key', columns: ['createdAt'], orders: ['DESC'] },
      { key: 'idx_posts_author_created', type: 'key', columns: ['authorId', 'createdAt'], orders: ['ASC', 'DESC'] },
      { key: 'idx_posts_likes', type: 'key', columns: ['likeCount'], orders: ['DESC'] },
      { key: 'idx_posts_content', type: 'fulltext', columns: ['content'] },
    ],
  },
  {
    id: 'comments',
    name: 'Comments',
    attributes: commentAttributes,
    indexes: [
      { key: 'idx_comments_post_created', type: 'key', columns: ['postId', 'createdAt'], orders: ['ASC', 'ASC'] },
      { key: 'idx_comments_author_created', type: 'key', columns: ['authorId', 'createdAt'], orders: ['ASC', 'DESC'] },
      { key: 'idx_comments_likes', type: 'key', columns: ['likeCount'], orders: ['DESC'] },
    ],
  },
  {
    id: 'post_likes',
    name: 'Post likes',
    attributes: postLikeAttributes,
    indexes: [
      { key: 'idx_post_likes_user', type: 'key', columns: ['userId', 'createdAt'], orders: ['ASC', 'DESC'] },
      { key: 'idx_post_likes_post', type: 'key', columns: ['postId'], orders: ['ASC'] },
    ],
  },
  {
    id: 'comment_likes',
    name: 'Comment likes',
    attributes: commentLikeAttributes,
    indexes: [
      { key: 'idx_comment_likes_user', type: 'key', columns: ['userId', 'createdAt'], orders: ['ASC', 'DESC'] },
      { key: 'idx_comment_likes_comment', type: 'key', columns: ['commentId'], orders: ['ASC'] },
    ],
  },
  {
    id: 'reposts',
    name: 'Reposts',
    attributes: repostAttributes,
    indexes: [
      { key: 'idx_reposts_user', type: 'key', columns: ['userId', 'createdAt'], orders: ['ASC', 'DESC'] },
      { key: 'idx_reposts_post', type: 'key', columns: ['postId'], orders: ['ASC'] },
    ],
  },
  {
    id: 'follows',
    name: 'Follows',
    attributes: followAttributes,
    indexes: [
      { key: 'idx_follows_follower', type: 'key', columns: ['followerId', 'createdAt'], orders: ['ASC', 'DESC'] },
      { key: 'idx_follows_following', type: 'key', columns: ['followingId'], orders: ['ASC'] },
    ],
  },
] as const

interface Manifest {
  version: 1
  kind: 'social'
  createdAt: string
  base: string
  project: string
  database: string
  prefix: string
  profiles: number
  posts: number
  comments: number
  postLikes: number
  commentLikes: number
  reposts: number
  follows: number
  firstProfileId: string
  secondProfileId: string
  firstPostId: string
  firstCommentId: string
  hotPostRegex: string
  hotCommentRegex: string
  hotProfileRegex: string
  stressUserId: string
  stressEmail: string
}

interface SeedOptions {
  prefix: string
  profiles: number
  posts: number
  comments: number
  postLikes: number
  commentLikes: number
  reposts: number
  follows: number
}

function profileId(prefix: string, index: number): string {
  return `${prefix}-u-${pad(index, 4)}`
}

function postId(prefix: string, index: number): string {
  return `${prefix}-p-${pad(index, 6)}`
}

function commentId(prefix: string, index: number): string {
  return `${prefix}-c-${pad(index, 6)}`
}

function username(prefix: string, index: number): string {
  return `${prefix}_u_${pad(index, 4)}`
}

function makeProfiles(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  return Array.from({ length: options.profiles }, (_, index) => ({
    $id: profileId(options.prefix, index),
    userId: profileId(options.prefix, index),
    username: username(options.prefix, index),
    displayName: `Stress User ${pad(index, 4)}`,
    bio: index % 5 === 0 ? `Social stress profile ${index} #stress` : '',
    avatarUrl: index % 3 === 0 ? `https://cdn.example.com/avatar/${index}.jpg` : '',
    followerCount: (index * 13) % 5000,
    followingCount: (index * 7) % 2000,
    postCount: (index * 3) % 100,
    verified: index % 17 === 0,
    createdAt: iso(now - index * 60_000),
  }))
}

function makePosts(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  return Array.from({ length: options.posts }, (_, index) => {
    const author = index % options.profiles
    return {
      $id: postId(options.prefix, index),
      authorId: profileId(options.prefix, author),
      authorUsername: username(options.prefix, author),
      content: `Stress social feed load test post ${index} #social #stress #load`,
      mediaUrl: index % 3 === 0 ? `https://cdn.example.com/media/${index}.jpg` : '',
      likeCount: (index * 7) % 500,
      commentCount: (index * 3) % 100,
      repostCount: index % 50,
      visibility: 'public',
      createdAt: iso(now - index * 30_000),
    }
  })
}

function makeComments(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  const discussed = Math.min(options.posts, HOT)
  return Array.from({ length: options.comments }, (_, index) => {
    const author = index % options.profiles
    return {
      $id: commentId(options.prefix, index),
      postId: postId(options.prefix, index % discussed),
      authorId: profileId(options.prefix, author),
      authorUsername: username(options.prefix, author),
      content: `Stress social comment ${index} on a load test post #stress`,
      likeCount: (index * 5) % 200,
      createdAt: iso(now - index * 15_000),
    }
  })
}

function makePostLikes(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  return Array.from({ length: options.postLikes }, (_, index) => ({
    $id: `${options.prefix}-pl-${pad(index, 6)}`,
    userId: profileId(options.prefix, index % options.profiles),
    postId: postId(options.prefix, index % options.posts),
    createdAt: iso(now - index * 20_000),
  }))
}

function makeCommentLikes(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  return Array.from({ length: options.commentLikes }, (_, index) => ({
    $id: `${options.prefix}-cl-${pad(index, 6)}`,
    userId: profileId(options.prefix, index % options.profiles),
    commentId: commentId(options.prefix, index % options.comments),
    createdAt: iso(now - index * 20_000),
  }))
}

function makeReposts(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  return Array.from({ length: options.reposts }, (_, index) => ({
    $id: `${options.prefix}-rp-${pad(index, 6)}`,
    userId: profileId(options.prefix, index % options.profiles),
    postId: postId(options.prefix, index % options.posts),
    createdAt: iso(now - index * 40_000),
  }))
}

function makeFollows(options: SeedOptions): Record<string, unknown>[] {
  const now = Date.now()
  return Array.from({ length: options.follows }, (_, index) => {
    const follower = index % options.profiles
    const following = (index * 7 + 1) % options.profiles
    return {
      $id: `${options.prefix}-f-${pad(index, 6)}`,
      followerId: profileId(options.prefix, follower),
      followingId: profileId(options.prefix, following === follower ? (following + 1) % options.profiles : following),
      createdAt: iso(now - index * 30_000),
    }
  })
}

async function bulkUpsert(
  apiOptions: ApiOptions,
  database: string,
  collection: string,
  documents: Record<string, unknown>[],
  batch: number,
  label: string,
): Promise<void> {
  for (let start = 0; start < documents.length; start += batch) {
    const end = Math.min(start + batch, documents.length)
    const result = await api(
      apiOptions,
      'PUT',
      `/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collection)}/documents`,
      { documents: documents.slice(start, end) },
    )
    assertOk(result, `seeding ${label} ${start}-${end}`)
    console.log(`  ${label}: ${end}/${documents.length}`)
  }
}

async function createSchema(apiOptions: ApiOptions, database: string): Promise<void> {
  const createdDatabase = await api(apiOptions, 'POST', '/databases', { databaseId: database, name: 'Social stress' })
  assertOk(createdDatabase, 'create database', [409])

  const base = `/databases/${encodeURIComponent(database)}/collections`
  const createOrUpdate = async (collectionId: string, body: Record<string, unknown>): Promise<void> => {
    const created = await api(apiOptions, 'POST', base, { collectionId, ...body })
    if (created.status !== 409) {
      assertOk(created, `create collection ${collectionId}`)
      return
    }
    const updated = await api(apiOptions, 'PUT', `${base}/${encodeURIComponent(collectionId)}`, body)
    assertOk(updated, `update collection ${collectionId}`)
  }

  for (const collection of collections) {
    // Reads are open to logged-in users; writes (and the counter updates a
    // like/comment/repost/follow triggers) are open to them too, so the
    // session run exercises the normal permission path instead of an API key.
    const permissions = ['read("users")', 'create("users")', 'update("users")']
    await createOrUpdate(collection.id, {
      name: collection.name,
      documentSecurity: false,
      permissions,
      attributes: collection.attributes,
      indexes: collection.indexes,
    })
    console.log(`  collection ${collection.id}`)
  }
}

function manifestPath(prefix: string): string {
  return resolve('data/stress', `social-${prefix}.json`)
}

function writeManifest(manifest: Manifest): string {
  const path = manifestPath(manifest.prefix)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

function readManifest(path: string): Manifest {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as Manifest
  if (parsed.version !== 1 || parsed.kind !== 'social' || !parsed.prefix || !parsed.base || !parsed.project || !parsed.database) {
    throw new Error(`Invalid manifest: ${path}`)
  }
  return parsed
}

function setupOptions(): {
  api: ApiOptions
  database: string
  prefix: string
  profiles: number
  posts: number
  comments: number
  postLikes: number
  commentLikes: number
  reposts: number
  follows: number
  batch: number
  reset: boolean
  seed: boolean
} {
  const base = normalizeBase(required(flag('base') ?? env('STRESS_BASE'), '--base (or STRESS_BASE)'))
  const project = required(flag('project') ?? env('STRESS_PROJECT'), '--project (or STRESS_PROJECT)')
  const key = required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)')
  const database = flag('database') ?? DEFAULT_DATABASE
  const prefix = assertId(flag('prefix') ?? DEFAULT_PREFIX, '--prefix')
  assertId(database, '--database')
  const reset = boolFlag('reset')
  if (reset && !/stress/i.test(database)) {
    throw new Error('--reset only deletes databases whose name contains "stress"')
  }
  const profiles = integerFlag('profiles', DEFAULT_PROFILES)
  const posts = integerFlag('posts', DEFAULT_POSTS)
  const comments = integerFlag('comments', DEFAULT_COMMENTS)
  const postLikes = integerFlag('post-likes', DEFAULT_POST_LIKES, 0)
  const commentLikes = integerFlag('comment-likes', DEFAULT_COMMENT_LIKES, 0)
  const reposts = integerFlag('reposts', DEFAULT_REPOSTS, 0)
  const follows = integerFlag('follows', DEFAULT_FOLLOWS, 0)
  if (profiles < HOT || posts < HOT || comments < HOT) {
    throw new Error(`--profiles, --posts and --comments must be at least ${HOT} for the hot-row counter paths`)
  }
  return {
    api: { base, project, key, timeout: numberFlag('timeout', 60) },
    database,
    prefix,
    profiles,
    posts,
    comments,
    postLikes,
    commentLikes,
    reposts,
    follows,
    batch: integerFlag('batch', DEFAULT_BATCH),
    reset,
    seed: !boolFlag('no-seed'),
  }
}

async function setup(): Promise<Manifest> {
  const options = setupOptions()
  console.log(`setting up ${options.api.base} project=${options.api.project} database=${options.database}`)
  if (options.reset) {
    const deleted = await api(options.api, 'DELETE', `/databases/${encodeURIComponent(options.database)}`)
    assertOk(deleted, 'reset database', [404])
    console.log(`reset database ${options.database}`)
  }
  await createSchema(options.api, options.database)

  // The session run logs in as this user. The API key creates it.
  const createdUser = await api(options.api, 'POST', '/users', {
    userId: SESSION_USER_ID,
    email: SESSION_EMAIL,
    password: SESSION_PASSWORD,
    name: 'Stress Social',
  })
  assertOk(createdUser, 'create session user', [409])

  const seedOptions: SeedOptions = {
    prefix: options.prefix,
    profiles: options.profiles,
    posts: options.posts,
    comments: options.comments,
    postLikes: options.postLikes,
    commentLikes: options.commentLikes,
    reposts: options.reposts,
    follows: options.follows,
  }

  const firstProfile = profileId(options.prefix, 0)
  const secondProfile = profileId(options.prefix, 1)
  const firstPost = postId(options.prefix, 0)
  const firstComment = commentId(options.prefix, 0)

  if (options.seed) {
    const profiles = makeProfiles(seedOptions)
    profiles.push({
      $id: SESSION_USER_ID,
      userId: SESSION_USER_ID,
      username: 'stress_session',
      displayName: 'Stress Session',
      bio: 'Logged-in user for the social session run',
      avatarUrl: '',
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      verified: true,
      createdAt: iso(Date.now()),
    })
    console.log(`seeding ${profiles.length} profiles`)
    await bulkUpsert(options.api, options.database, 'profiles', profiles, options.batch, 'profiles')
    console.log(`seeding ${seedOptions.posts} posts`)
    await bulkUpsert(options.api, options.database, 'posts', makePosts(seedOptions), options.batch, 'posts')
    console.log(`seeding ${seedOptions.comments} comments`)
    await bulkUpsert(options.api, options.database, 'comments', makeComments(seedOptions), options.batch, 'comments')
    console.log(`seeding ${seedOptions.postLikes} post likes`)
    await bulkUpsert(options.api, options.database, 'post_likes', makePostLikes(seedOptions), options.batch, 'post likes')
    console.log(`seeding ${seedOptions.commentLikes} comment likes`)
    await bulkUpsert(options.api, options.database, 'comment_likes', makeCommentLikes(seedOptions), options.batch, 'comment likes')
    console.log(`seeding ${seedOptions.reposts} reposts`)
    await bulkUpsert(options.api, options.database, 'reposts', makeReposts(seedOptions), options.batch, 'reposts')
    console.log(`seeding ${seedOptions.follows} follows`)
    await bulkUpsert(options.api, options.database, 'follows', makeFollows(seedOptions), options.batch, 'follows')
  } else {
    console.log('schema only (--no-seed)')
  }

  const manifest: Manifest = {
    version: 1,
    kind: 'social',
    createdAt: new Date().toISOString(),
    base: options.api.base,
    project: options.api.project,
    database: options.database,
    prefix: options.prefix,
    profiles: options.profiles,
    posts: options.posts,
    comments: options.comments,
    postLikes: options.postLikes,
    commentLikes: options.commentLikes,
    reposts: options.reposts,
    follows: options.follows,
    firstProfileId: firstProfile,
    secondProfileId: secondProfile,
    firstPostId: firstPost,
    firstCommentId: firstComment,
    hotPostRegex: `${escapeRegex(options.prefix)}-p-0000[0-9]{2}`,
    hotCommentRegex: `${escapeRegex(options.prefix)}-c-0000[0-9]{2}`,
    hotProfileRegex: `${escapeRegex(options.prefix)}-u-00[0-9]{2}`,
    stressUserId: SESSION_USER_ID,
    stressEmail: SESSION_EMAIL,
  }
  const path = writeManifest(manifest)
  const total =
    options.profiles + options.posts + options.comments + options.postLikes + options.commentLikes + options.reposts + options.follows
  console.log(`\nseeded ${total} documents (${options.profiles} profiles, ${options.posts} posts, ${options.comments} comments)`)
  console.log(`manifest: ${path}`)
  console.log(`\nnext:\n  bun run stress:social run --manifest ${JSON.stringify(path)}\n  bun run stress:social mix --manifest ${JSON.stringify(path)}\n  bun run stress:social session --manifest ${JSON.stringify(path)}`)
  return manifest
}

interface RunOptions {
  manifest: Manifest
  api: ApiOptions
  concurrency: number[]
  writeConcurrency: number[]
  duration: number
  warmup: number
  timeout: number
  tool: 'auto' | 'oha' | 'builtin'
  total: boolean
  out: string
  paths: string[]
}

const READ_PATHS = [
  'feed',
  'feed-following',
  'trending',
  'post',
  'comments',
  'profile',
  'profile-posts',
  'search',
] as const

const WRITE_PATHS = [
  'create-post',
  'like',
  'like-count',
  'comment',
  'comment-like',
  'comment-like-count',
  'repost',
  'repost-count',
  'follow',
  'follow-count',
] as const

const ALL_PATHS: string[] = [...READ_PATHS, ...WRITE_PATHS]

function parsePaths(): string[] {
  const raw = flag('paths') ?? env('STRESS_PATHS')
  if (!raw) return ALL_PATHS
  const out = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  for (const path of out) {
    // "me" is session-only; keep it selectable from the same flag.
    if (path !== 'me' && !ALL_PATHS.includes(path)) {
      throw new Error(`Unknown path "${path}". Known: ${[...ALL_PATHS, 'me'].join(', ')}`)
    }
  }
  return out
}

function loadImplicitManifest(): Manifest {
  const prefix = flag('prefix')
  if (!prefix) throw new Error('Pass --manifest or --prefix, or run setup first.')
  return readManifest(manifestPath(assertId(prefix, '--prefix')))
}

function runOptions(manifestOverride?: Manifest): RunOptions {
  const manifestPath = flag('manifest') ?? env('STRESS_MANIFEST')
  const manifest = manifestOverride ?? (manifestPath ? readManifest(manifestPath) : loadImplicitManifest())
  const base = normalizeBase(flag('base') ?? env('STRESS_BASE') ?? manifest.base)
  const project = flag('project') ?? env('STRESS_PROJECT') ?? manifest.project
  const key = required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)')
  const tool = (flag('tool') ?? env('STRESS_TOOL') ?? 'auto') as RunOptions['tool']
  if (!['auto', 'oha', 'builtin'].includes(tool)) throw new Error('--tool must be auto, oha or builtin')
  return {
    manifest,
    api: { base, project, key, timeout: numberFlag('timeout', DEFAULT_TIMEOUT) },
    concurrency: levels('concurrency', DEFAULT_CONCURRENCY),
    writeConcurrency: levels('write-concurrency', DEFAULT_WRITE_CONCURRENCY),
    duration: integerFlag('duration', DEFAULT_DURATION),
    warmup: integerFlag('warmup', DEFAULT_WARMUP, 0),
    timeout: integerFlag('timeout', DEFAULT_TIMEOUT),
    tool,
    total: boolFlag('total'),
    out: flag('out') ?? 'data/stress',
    paths: parsePaths(),
  }
}

function documents(base: string, database: string, collection: string): string {
  return `${base}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collection)}/documents`
}

function targetUrls(manifest: Manifest, base: string, total: boolean): Record<string, string> {
  const posts = documents(base, manifest.database, 'posts')
  const comments = documents(base, manifest.database, 'comments')
  const profiles = documents(base, manifest.database, 'profiles')

  const feedSelect = ['$id', 'authorId', 'authorUsername', 'content', 'mediaUrl', 'likeCount', 'commentCount', 'repostCount', 'createdAt']
  const commentSelect = ['$id', 'postId', 'authorId', 'authorUsername', 'content', 'likeCount', 'createdAt']

  const feedQuery = queryString(
    [
      { method: 'orderDesc', attribute: 'createdAt' },
      { method: 'limit', values: [20] },
      { method: 'select', values: feedSelect },
    ],
    total,
  )
  const following = Array.from({ length: 30 }, (_, index) => profileId(manifest.prefix, index))
  const followingQuery = queryString(
    [
      { method: 'equal', attribute: 'authorId', values: following },
      { method: 'orderDesc', attribute: 'createdAt' },
      { method: 'limit', values: [20] },
      { method: 'select', values: feedSelect },
    ],
    total,
  )
  const trendingQuery = queryString(
    [
      { method: 'orderDesc', attribute: 'likeCount' },
      { method: 'limit', values: [20] },
      { method: 'select', values: feedSelect },
    ],
    total,
  )
  const commentsQuery = queryString(
    [
      { method: 'equal', attribute: 'postId', values: [manifest.firstPostId] },
      { method: 'orderAsc', attribute: 'createdAt' },
      { method: 'limit', values: [30] },
      { method: 'select', values: commentSelect },
    ],
    total,
  )
  const profilePostsQuery = queryString(
    [
      { method: 'equal', attribute: 'authorId', values: [manifest.firstProfileId] },
      { method: 'orderDesc', attribute: 'createdAt' },
      { method: 'limit', values: [20] },
      { method: 'select', values: feedSelect },
    ],
    total,
  )
  const searchQuery = queryString(
    [
      { method: 'search', attribute: 'content', values: ['stress social'] },
      { method: 'orderDesc', attribute: 'createdAt' },
      { method: 'limit', values: [20] },
      { method: 'select', values: feedSelect },
    ],
    total,
  )

  return {
    feed: `${posts}?${feedQuery}`,
    'feed-following': `${posts}?${followingQuery}`,
    trending: `${posts}?${trendingQuery}`,
    post: `${posts}/${encodeURIComponent(manifest.firstPostId)}?total=false`,
    comments: `${comments}?${commentsQuery}`,
    profile: `${profiles}/${encodeURIComponent(manifest.firstProfileId)}?total=false`,
    'profile-posts': `${posts}?${profilePostsQuery}`,
    search: `${posts}?${searchQuery}`,
  }
}

function postBody(manifest: Manifest): string {
  return JSON.stringify({
    data: {
      authorId: manifest.firstProfileId,
      authorUsername: username(manifest.prefix, 0),
      content: 'Load test post created by the social stress runner #stress',
      mediaUrl: '',
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      visibility: 'public',
      createdAt: new Date().toISOString(),
    },
  })
}

function likeBody(manifest: Manifest): string {
  return JSON.stringify({
    data: { userId: manifest.firstProfileId, postId: manifest.firstPostId, createdAt: new Date().toISOString() },
  })
}

function commentBody(manifest: Manifest): string {
  return JSON.stringify({
    data: {
      postId: manifest.firstPostId,
      authorId: manifest.firstProfileId,
      authorUsername: username(manifest.prefix, 0),
      content: 'Load test comment created by the social stress runner #stress',
      likeCount: 0,
      createdAt: new Date().toISOString(),
    },
  })
}

function commentLikeBody(manifest: Manifest): string {
  return JSON.stringify({
    data: { userId: manifest.firstProfileId, commentId: manifest.firstCommentId, createdAt: new Date().toISOString() },
  })
}

function repostBody(manifest: Manifest): string {
  return JSON.stringify({
    data: { userId: manifest.firstProfileId, postId: manifest.firstPostId, createdAt: new Date().toISOString() },
  })
}

function followBody(manifest: Manifest): string {
  return JSON.stringify({
    data: {
      followerId: manifest.firstProfileId,
      followingId: manifest.secondProfileId,
      createdAt: new Date().toISOString(),
    },
  })
}

function randomHot(prefix: string, kind: 'p' | 'c' | 'u'): string {
  const index = Math.floor(Math.random() * HOT)
  if (kind === 'p') return postId(prefix, index)
  if (kind === 'c') return commentId(prefix, index)
  return profileId(prefix, index)
}

function targetsFor(options: RunOptions): Target[] {
  const urls = targetUrls(options.manifest, options.api.base, options.total)
  const posts = documents(options.api.base, options.manifest.database, 'posts')
  const comments = documents(options.api.base, options.manifest.database, 'comments')
  const profiles = documents(options.api.base, options.manifest.database, 'profiles')
  const prefix = options.manifest.prefix
  const writeConcurrency = options.writeConcurrency

  const targets: Target[] = [
    { name: 'feed', url: urls.feed! },
    { name: 'feed-following', url: urls['feed-following']! },
    { name: 'trending', url: urls.trending! },
    { name: 'post', url: urls.post! },
    { name: 'comments', url: urls.comments! },
    { name: 'profile', url: urls.profile! },
    { name: 'profile-posts', url: urls['profile-posts']! },
    { name: 'search', url: urls.search! },
    {
      name: 'create-post',
      url: `${posts}/${escapeRegex(prefix)}-np-[a-z0-9]{12}`,
      method: 'PUT',
      body: postBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${posts}/${prefix}-np-${randomId()}`,
    },
    {
      name: 'like',
      url: `${documents(options.api.base, options.manifest.database, 'post_likes')}/${escapeRegex(prefix)}-lk-[a-z0-9]{12}`,
      method: 'PUT',
      body: likeBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${documents(options.api.base, options.manifest.database, 'post_likes')}/${prefix}-lk-${randomId()}`,
    },
    {
      name: 'like-count',
      url: `${posts}/${options.manifest.hotPostRegex}/likeCount/increment`,
      method: 'PATCH',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${posts}/${randomHot(prefix, 'p')}/likeCount/increment`,
    },
    {
      name: 'comment',
      url: `${comments}/${escapeRegex(prefix)}-cm-[a-z0-9]{12}`,
      method: 'PUT',
      body: commentBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${comments}/${prefix}-cm-${randomId()}`,
    },
    {
      name: 'comment-like',
      url: `${documents(options.api.base, options.manifest.database, 'comment_likes')}/${escapeRegex(prefix)}-ck-[a-z0-9]{12}`,
      method: 'PUT',
      body: commentLikeBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () =>
        `${documents(options.api.base, options.manifest.database, 'comment_likes')}/${prefix}-ck-${randomId()}`,
    },
    {
      name: 'comment-like-count',
      url: `${comments}/${options.manifest.hotCommentRegex}/likeCount/increment`,
      method: 'PATCH',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${comments}/${randomHot(prefix, 'c')}/likeCount/increment`,
    },
    {
      name: 'repost',
      url: `${documents(options.api.base, options.manifest.database, 'reposts')}/${escapeRegex(prefix)}-rs-[a-z0-9]{12}`,
      method: 'PUT',
      body: repostBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () =>
        `${documents(options.api.base, options.manifest.database, 'reposts')}/${prefix}-rs-${randomId()}`,
    },
    {
      name: 'repost-count',
      url: `${posts}/${options.manifest.hotPostRegex}/repostCount/increment`,
      method: 'PATCH',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${posts}/${randomHot(prefix, 'p')}/repostCount/increment`,
    },
    {
      name: 'follow',
      url: `${documents(options.api.base, options.manifest.database, 'follows')}/${escapeRegex(prefix)}-fl-[a-z0-9]{12}`,
      method: 'PUT',
      body: followBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${documents(options.api.base, options.manifest.database, 'follows')}/${prefix}-fl-${randomId()}`,
    },
    {
      name: 'follow-count',
      url: `${profiles}/${options.manifest.hotProfileRegex}/followerCount/increment`,
      method: 'PATCH',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${profiles}/${randomHot(prefix, 'u')}/followerCount/increment`,
    },
  ]

  const selected = new Set(options.paths)
  return targets.filter((target) => selected.has(target.name))
}

function sessionTargets(manifest: Manifest, base: string, writeConcurrency: number[], paths: string[]): Target[] {
  const urls = targetUrls(manifest, base, true)
  const posts = documents(base, manifest.database, 'posts')
  const postLikes = documents(base, manifest.database, 'post_likes')
  const targetList: Target[] = [
    { name: 'feed', url: urls.feed! },
    { name: 'feed-following', url: urls['feed-following']! },
    { name: 'trending', url: urls.trending! },
    { name: 'post', url: urls.post! },
    { name: 'comments', url: urls.comments! },
    { name: 'profile', url: urls.profile! },
    { name: 'profile-posts', url: urls['profile-posts']! },
    { name: 'search', url: urls.search! },
    {
      name: 'me',
      url: `${documents(base, manifest.database, 'profiles')}/${encodeURIComponent(manifest.stressUserId)}?total=false`,
    },
    {
      name: 'create-post',
      url: `${posts}/${escapeRegex(manifest.prefix)}-sp-[a-z0-9]{12}`,
      method: 'PUT',
      body: JSON.stringify({
        data: {
          authorId: manifest.stressUserId,
          authorUsername: 'stress_session',
          content: 'Session load test post #stress',
          likeCount: 0,
          commentCount: 0,
          repostCount: 0,
          visibility: 'public',
          createdAt: new Date().toISOString(),
        },
      }),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${posts}/${manifest.prefix}-sp-${randomId()}`,
    },
    {
      name: 'like',
      url: `${postLikes}/${escapeRegex(manifest.prefix)}-sl-[a-z0-9]{12}`,
      method: 'PUT',
      body: JSON.stringify({
        data: { userId: manifest.stressUserId, postId: manifest.firstPostId, createdAt: new Date().toISOString() },
      }),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: writeConcurrency,
      urlFor: () => `${postLikes}/${manifest.prefix}-sl-${randomId()}`,
    },
  ]
  // Only run the selected paths; "me" is session-only.
  const selected = new Set(paths)
  return targetList.filter((target) => selected.has(target.name))
}

interface MixedPathResult {
  target: string
  concurrency: number
  rps: number
  p95ms: number
  successPct: number
  status: Record<string, number>
  errors: Record<string, number>
}

interface MixedLevel {
  concurrency: number
  durationSec: number
  totalRps: number
  p95ms: number
  successPct: number
  paths: MixedPathResult[]
}

const MIX_SHARES: Record<string, number> = {
  feed: 0.27,
  'feed-following': 0.08,
  trending: 0.04,
  post: 0.10,
  comments: 0.08,
  profile: 0.04,
  'profile-posts': 0.04,
  search: 0.03,
  'create-post': 0.07,
  like: 0.05,
  'like-count': 0.04,
  comment: 0.04,
  'comment-like': 0.03,
  'comment-like-count': 0.02,
  repost: 0.02,
  'repost-count': 0.01,
  follow: 0.02,
  'follow-count': 0.02,
}

function sharesFor(paths: string[]): Record<string, number> {
  const selected = Object.entries(MIX_SHARES).filter(([name]) => paths.includes(name))
  const total = selected.reduce((sum, [, share]) => sum + share, 0)
  return Object.fromEntries(selected.map(([name, share]) => [name, share / total]))
}

async function runOhaMix(
  target: Target,
  concurrency: number,
  duration: number,
  timeout: number,
  headers: Record<string, string>,
): Promise<MixedPathResult> {
  const args = ['-z', `${duration}s`, '-c', String(concurrency), '-t', `${timeout}s`, '--no-tui', '-j']
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`)
  if (target.randomUrl) args.push('--rand-regex-url')
  if (target.method) args.push('-m', target.method)
  if (target.body) args.push('-d', target.body)
  if (target.contentType) args.push('-T', target.contentType)
  args.push(target.url)

  const proc = Bun.spawn(['oha', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), (duration + timeout + 10) * 1000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`oha ${target.name} exited ${code}: ${stderr.slice(0, 400)}`)
    const raw = JSON.parse(stdout) as {
      latencyPercentiles?: Record<string, number>
      statusCodeDistribution?: Record<string, number>
      errorDistribution?: Record<string, number>
    }
    const status = raw.statusCodeDistribution ?? {}
    const errors = raw.errorDistribution ?? {}
    const attempts = [...Object.values(status), ...Object.values(errors)].reduce((sum, count) => sum + Number(count), 0)
    const ok = Object.entries(status)
      .filter(([code]) => {
        const value = Number(code)
        return value >= 200 && value < 400
      })
      .reduce((sum, [, count]) => sum + Number(count), 0)
    return {
      target: target.name,
      concurrency,
      rps: attempts / duration,
      p95ms: (raw.latencyPercentiles?.p95 ?? 0) * 1000,
      successPct: attempts === 0 ? 0 : (ok / attempts) * 100,
      status,
      errors,
    }
  } finally {
    clearTimeout(timer)
  }
}

function allocateMix(total: number, targets: Target[], shares: Record<string, number>): { target: Target; concurrency: number }[] {
  const byName = new Map(targets.map((target) => [target.name, target]))
  const entries = Object.entries(shares)
  let used = 0
  const out: { target: Target; concurrency: number }[] = []
  for (const [index, [name, share]] of entries.entries()) {
    const target = byName.get(name)
    if (!target) throw new Error(`Missing target ${name}`)
    const clients = index === entries.length - 1 ? Math.max(1, total - used) : Math.max(1, Math.round(total * share))
    used += clients
    out.push({ target, concurrency: clients })
  }
  return out
}

async function runMixedLevel(
  level: number,
  duration: number,
  timeout: number,
  headers: Record<string, string>,
  targets: Target[],
  shares: Record<string, number>,
): Promise<MixedLevel> {
  const allocations = allocateMix(level, targets, shares)
  const paths = await Promise.all(
    allocations.map(({ target, concurrency }) => runOhaMix(target, concurrency, duration, timeout, headers)),
  )
  const attempts = paths.reduce((sum, path) => sum + path.rps * duration, 0)
  const ok = paths.reduce((sum, path) => sum + (path.rps * duration * path.successPct) / 100, 0)
  return {
    concurrency: level,
    durationSec: duration,
    totalRps: paths.reduce((sum, path) => sum + path.rps, 0),
    p95ms: Math.max(...paths.map((path) => path.p95ms)),
    successPct: attempts === 0 ? 0 : (ok / attempts) * 100,
    paths,
  }
}

async function runMix(): Promise<void> {
  const options = runOptions()
  if (!Bun.which('oha')) throw new Error('Mixed load needs oha: brew install oha')
  const mixLevels = levels('mix-concurrency', DEFAULT_MIX_CONCURRENCY)
  const duration = integerFlag('mix-duration', DEFAULT_MIX_DURATION)
  const warmup = integerFlag('mix-warmup', DEFAULT_MIX_WARMUP, 0)
  const headers = {
    'X-Appwrite-Project': options.api.project,
    'X-Appwrite-Key': options.api.key,
  }
  const targets = targetsFor(options)
  const shares = sharesFor(targets.map((target) => target.name))
  console.log(`mixed social load: ${options.api.base} project=${options.api.project}`)
  console.log(`levels=${mixLevels.join(',')} duration=${duration}s warmup=${warmup}s paths=${targets.length}`)

  const results: MixedLevel[] = []
  for (const level of mixLevels) {
    if (warmup > 0) {
      console.log(`  warmup ${warmup}s at total c=${Math.max(20, Math.round(level / 2))}`)
      await runMixedLevel(Math.max(20, Math.round(level / 2)), warmup, options.timeout, headers, targets, shares)
    }
    const result = await runMixedLevel(level, duration, options.timeout, headers, targets, shares)
    results.push(result)
    console.log(
      `  total c=${String(level).padStart(3)}  ${result.totalRps.toFixed(0).padStart(6)} rps  ` +
        `p95(max)=${result.p95ms.toFixed(0).padStart(5)}ms  ok=${result.successPct.toFixed(2)}%  ` +
        `users@${CALLS_PER_USER_MINUTE}/min≈${((result.totalRps * 60) / CALLS_PER_USER_MINUTE).toFixed(0)}`,
    )
    for (const path of result.paths) {
      console.log(
        `    ${path.target.padEnd(18)} c=${String(path.concurrency).padStart(3)}  ` +
          `${path.rps.toFixed(0).padStart(6)} rps  p95=${path.p95ms.toFixed(0).padStart(5)}ms  ok=${path.successPct.toFixed(2)}%`,
      )
    }
  }

  const report = mixedReport(options, results)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = resolve(options.out, `social-mix-${stamp}.json`)
  const mdPath = resolve(options.out, `social-mix-${stamp}.md`)
  mkdirSync(options.out, { recursive: true })
  const safeOptions = {
    manifest: options.manifest,
    api: { ...options.api, key: '[redacted]' },
    duration: options.duration,
    timeout: options.timeout,
    paths: options.paths,
  }
  writeFileSync(jsonPath, `${JSON.stringify({ kind: 'social-mix', options: safeOptions, results }, null, 2)}\n`)
  writeFileSync(mdPath, report)
  console.log(`\n${report}`)
  console.log(`report: ${mdPath}`)
  console.log(`raw:    ${jsonPath}`)
}

function mixedReport(options: RunOptions, results: MixedLevel[]): string {
  const lines: string[] = []
  lines.push('# Social-media mixed load test')
  lines.push('')
  lines.push(`- Endpoint: \`${options.api.base}\``)
  lines.push(`- Project: \`${options.api.project}\``)
  lines.push(`- Duration: ${results[0]?.durationSec ?? 0}s per level`)
  lines.push(`- Paths: ${options.paths.length}`)
  lines.push(`- Mix: ${Object.entries(sharesFor(options.paths))
    .map(([name, share]) => `${name} ${(share * 100).toFixed(0)}%`)
    .join(', ')}`)
  lines.push('')
  lines.push('## Measured throughput')
  lines.push('')
  lines.push('| Total clients | Total RPS | Worst p95 | Success | Active users @ 20 calls/min | Constraint |')
  lines.push('| ---: | ---: | ---: | ---: | ---: | --- |')
  for (const result of results) {
    const worst = result.paths.reduce((a, b) => (a.p95ms >= b.p95ms ? a : b))
    const failed = result.paths.find((path) => path.successPct < 99)
    const constraint = failed ? `${failed.target} errors ${(100 - failed.successPct).toFixed(2)}%` : worst.target
    lines.push(
      `| ${result.concurrency} | ${result.totalRps.toFixed(0)} | ${result.p95ms.toFixed(0)} ms | ${result.successPct.toFixed(2)}% | ${((result.totalRps * 60) / CALLS_PER_USER_MINUTE).toFixed(0)} | ${constraint} |`,
    )
  }
  lines.push('')
  lines.push('## Path detail')
  lines.push('')
  lines.push('| Total clients | Path | Clients | RPS | p95 | Success |')
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: |')
  for (const result of results) {
    for (const path of result.paths) {
      lines.push(
        `| ${result.concurrency} | ${path.target} | ${path.concurrency} | ${path.rps.toFixed(0)} | ${path.p95ms.toFixed(0)} ms | ${path.successPct.toFixed(2)}% |`,
      )
    }
  }
  lines.push('')
  lines.push('## Capacity at SLO')
  lines.push('')
  lines.push(`Active users assume ${CALLS_PER_USER_MINUTE} social API calls per user per 60 s (feed scroll, post opens, likes, comments and counters).`)
  lines.push('')
  lines.push('| SLO | Safe total clients | Throughput | Active users @ 20 calls/min |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const slo of [300, 500, 1000]) {
    const passing = results.filter((result) => result.successPct >= 99 && result.p95ms <= slo)
    const best = passing.sort((a, b) => b.concurrency - a.concurrency)[0]
    if (!best) {
      lines.push(`| p95 <= ${slo} ms | none | 0 rps | 0 |`)
    } else {
      lines.push(
        `| p95 <= ${slo} ms | ${best.concurrency} | ${best.totalRps.toFixed(0)} rps | ${((best.totalRps * 60) / CALLS_PER_USER_MINUTE).toFixed(0)} |`,
      )
    }
  }
  lines.push('')
  lines.push('## Qualification')
  lines.push('')
  lines.push('This is a real concurrent mix: every path runs at the same time with clients split by the mix percentages.')
  lines.push('It runs from a remote client, so the numbers include network/TLS latency and the client machine.')
  lines.push('It excludes WebSocket realtime delivery, media uploads/storage, notifications and HTML rendering.')
  return `${lines.join('\n')}\n`
}

interface Capacity {
  target: string
  concurrency: number
  rps: number
  p95ms: number
  successPct: number
}

interface Slo {
  label: string
  p95ms: number
}

function capacityAt(results: RunResult[], target: string, slo: Slo): Capacity | null {
  const passing = results.filter(
    (result) => result.target === target && result.successPct >= 99 && result.p95ms <= slo.p95ms,
  )
  if (passing.length === 0) return null
  const best = passing.sort((a, b) => b.concurrency - a.concurrency)[0]!
  return {
    target: best.target,
    concurrency: best.concurrency,
    rps: best.rps,
    p95ms: best.p95ms,
    successPct: best.successPct,
  }
}

function markdownReport(options: RunOptions, results: RunResult[], file: string): string {
  const slos: Slo[] = [
    { label: 'strict (p95 <= 300 ms)', p95ms: 300 },
    { label: 'balanced (p95 <= 500 ms)', p95ms: 500 },
    { label: 'loose (p95 <= 1000 ms)', p95ms: 1000 },
  ]
  const weights = sharesFor(options.paths)
  const lines: string[] = []
  lines.push('# Social-media load test')
  lines.push('')
  lines.push(`- Endpoint: \`${options.api.base}\``)
  lines.push(`- Project: \`${options.api.project}\``)
  lines.push(`- Database: \`${options.manifest.database}\``)
  lines.push(`- Prefix: \`${options.manifest.prefix}\``)
  lines.push(
    `- Seeded: ${options.manifest.profiles} profiles, ${options.manifest.posts} posts, ${options.manifest.comments} comments, ` +
      `${options.manifest.postLikes} post likes, ${options.manifest.commentLikes} comment likes, ` +
      `${options.manifest.reposts} reposts, ${options.manifest.follows} follows`,
  )
  lines.push(`- Run: ${options.duration}s per level, warmup ${options.warmup}s, read concurrency ${options.concurrency.join(', ')}, write concurrency ${options.writeConcurrency.join(', ')}`)
  lines.push('')
  lines.push('## Per-path results')
  lines.push('')
  lines.push('| Path | Concurrency | RPS | p50 | p95 | p99 | OK |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const result of results) {
    lines.push(
      `| ${result.target} | ${result.concurrency} | ${result.rps.toFixed(0)} | ${result.p50ms.toFixed(1)} ms | ${result.p95ms.toFixed(1)} ms | ${result.p99ms.toFixed(1)} ms | ${result.successPct.toFixed(2)}% |`,
    )
  }
  lines.push('')
  lines.push('## Estimated capacity')
  lines.push('')
  lines.push(`Model: one active user makes ${CALLS_PER_USER_MINUTE} social API calls per 60 s. The weights below are the same mix used by the concurrent run.`)
  lines.push('The mixed RPS is the harmonic combination of each path at the highest passing concurrency; the user count is a model, not a measured WebSocket/session count.')
  lines.push('')
  lines.push('| SLO | Mixed RPS | Active users @ 20 calls/min | Concurrent requests | Limiting path |')
  lines.push('| --- | ---: | ---: | ---: | --- |')
  for (const slo of slos) {
    const capacities = Object.keys(weights)
      .map((target) => capacityAt(results, target, slo))
      .filter((entry): entry is Capacity => entry !== null)
    if (capacities.length === 0) {
      lines.push(`| ${slo.label} | 0 | 0 | 0 | none passed |`)
      continue
    }
    const totalWeight = capacities.reduce((sum, entry) => sum + (weights[entry.target] ?? 0), 0)
    const mixedRps = 1 / capacities.reduce((sum, entry) => sum + (weights[entry.target] ?? 0) / Math.max(0.001, entry.rps), 0)
    const activeUsers = (mixedRps * 60) / CALLS_PER_USER_MINUTE
    const avgLatency = capacities.reduce((sum, entry) => sum + (weights[entry.target] ?? 0) * entry.p95ms, 0) / totalWeight
    const concurrent = (mixedRps * avgLatency) / 1000
    const limiting = capacities.sort((a, b) => a.rps - b.rps)[0]!
    lines.push(
      `| ${slo.label} | ${mixedRps.toFixed(0)} | ${activeUsers.toFixed(0)} | ${concurrent.toFixed(1)} | ${limiting.target} (${limiting.rps.toFixed(0)} rps) |`,
    )
  }
  lines.push('')
  lines.push('## Qualification')
  lines.push('')
  lines.push('These are HTTP API numbers from a remote client. They include network and TLS latency, so they are lower than a local loopback benchmark.')
  lines.push('The estimate excludes WebSocket realtime delivery, media uploads/storage, notifications, function runs and admin console traffic.')
  lines.push('Like/comment/repost/follow actions in most clients also update a counter; the `*-count` paths measure that second write separately.')
  lines.push('')
  lines.push(`Raw results: \`${file}\``)
  return `${lines.join('\n')}\n`
}

/** Sign in as the stress user; no API key, so the session and permission paths are exercised. */
async function signIn(base: string, project: string, timeout: number, email: string): Promise<string> {
  const response = await fetch(`${base}/account/sessions/email`, {
    method: 'POST',
    headers: { 'X-Appwrite-Project': project, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: SESSION_PASSWORD }),
    signal: AbortSignal.timeout(timeout * 1000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`session login failed: HTTP ${response.status} ${text.slice(0, 1000)}`)
  const fallback = response.headers.get('x-fallback-cookies')
  if (fallback) {
    try {
      const secret = Object.values(JSON.parse(fallback) as Record<string, string>)[0]
      if (secret) return secret
    } catch {
      /* fall through to the cookie/body */
    }
  }
  const cookie = /(?:^|;\s*)[^=]+=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')
  if (cookie?.[1]) return decodeURIComponent(cookie[1])
  try {
    const body = JSON.parse(text) as { secret?: string }
    if (body.secret) return body.secret
  } catch {
    /* not JSON */
  }
  throw new Error('session login did not return a secret')
}

async function runSession(): Promise<void> {
  const options = runOptions()
  const secret = await signIn(options.api.base, options.api.project, options.timeout, options.manifest.stressEmail)
  console.log(`session social load: ${options.api.base} project=${options.api.project} (session + permissions)`)

  const { results, file } = await runMatrix({
    targets: sessionTargets(
      options.manifest,
      options.api.base,
      options.writeConcurrency,
      flag('paths') ? options.paths : [...ALL_PATHS, 'me'],
    ),
    headers: { 'X-Appwrite-Project': options.api.project, 'X-Appwrite-Session': secret },
    concurrency: options.concurrency,
    duration: options.duration,
    warmup: options.warmup,
    timeout: options.timeout,
    tool: options.tool,
    outDir: options.out,
    meta: {
      kind: 'social-session',
      startedAt: new Date().toISOString(),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      base: options.api.base,
      project: options.api.project,
      database: options.manifest.database,
      prefix: options.manifest.prefix,
      concurrency: options.concurrency,
      writeConcurrency: options.writeConcurrency,
      durationSec: options.duration,
      callsPerUserMinute: CALLS_PER_USER_MINUTE,
    },
    log: (line) => console.log(line),
  })

  for (const result of results) {
    console.log(
      `${result.target.padEnd(18)} c=${String(result.concurrency).padStart(4)} ${result.rps.toFixed(0).padStart(6)} rps p95=${result.p95ms.toFixed(1)}ms ok=${result.successPct.toFixed(2)}%`,
    )
  }
  console.log(`raw results: ${file}`)
}

async function cleanup(): Promise<void> {
  const base = normalizeBase(required(flag('base') ?? env('STRESS_BASE'), '--base (or STRESS_BASE)'))
  const project = required(flag('project') ?? env('STRESS_PROJECT'), '--project (or STRESS_PROJECT)')
  const key = required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)')
  const database = flag('database') ?? DEFAULT_DATABASE
  assertId(database, '--database')
  if (!/stress/i.test(database) && !boolFlag('yes')) {
    throw new Error('Refusing to delete a database without "stress" in its name; pass --yes to override.')
  }
  if (!boolFlag('yes')) {
    console.log(`Would delete ${database}. Pass --yes to confirm.`)
    process.exit(0)
  }
  const result = await api({ base, project, key, timeout: 30 }, 'DELETE', `/databases/${encodeURIComponent(database)}`)
  assertOk(result, 'delete database', [404])
  console.log(`deleted ${database}`)
}

function usage(): void {
  console.log(`Social-media stress test for Bunwrite.

Usage:
  bun run stress:social setup   [options]
  bun run stress:social run     [options]
  bun run stress:social mix     [options]
  bun run stress:social session [options]
  bun run stress:social all     [options]
  bun run stress:social cleanup --yes [options]

Common:
  --base <url>              API root, e.g. https://bunwrite.example.com/v1
  --project <id>            X-Appwrite-Project
  --key <key>               API key (or STRESS_API_KEY)
  --database <id>           Default: ${DEFAULT_DATABASE}
  --prefix <text>           Document prefix (letters, digits, . _ -)
  --manifest <path>         Manifest written by setup
  --timeout <seconds>       Request timeout, default ${DEFAULT_TIMEOUT}
  --paths <a,b>             Subset of paths to run (default: all)

Setup:
  --profiles <n>            Default: ${DEFAULT_PROFILES}
  --posts <n>               Default: ${DEFAULT_POSTS}
  --comments <n>            Default: ${DEFAULT_COMMENTS}
  --post-likes <n>          Default: ${DEFAULT_POST_LIKES}
  --comment-likes <n>       Default: ${DEFAULT_COMMENT_LIKES}
  --reposts <n>             Default: ${DEFAULT_REPOSTS}
  --follows <n>             Default: ${DEFAULT_FOLLOWS}
  --batch <n>               Bulk write batch size, default ${DEFAULT_BATCH}
  --reset                   Delete the stress database first (name must contain "stress")
  --no-seed                 Create/update the schema but skip seeding

Run:
  --concurrency <list>      Read clients, default: ${DEFAULT_CONCURRENCY}
  --write-concurrency <list> Write clients, default: ${DEFAULT_WRITE_CONCURRENCY}
  --duration <seconds>      Per level, default ${DEFAULT_DURATION}
  --warmup <seconds>        Default ${DEFAULT_WARMUP}
  --mix-concurrency <list>  Mixed clients, default: ${DEFAULT_MIX_CONCURRENCY}
  --mix-duration <seconds>  Mixed level, default ${DEFAULT_MIX_DURATION}
  --mix-warmup <seconds>    Mixed warmup, default ${DEFAULT_MIX_WARMUP}
  --total                   Request total=true on list queries
  --tool <auto|oha|builtin> Default: auto
  --out <dir>               Default: data/stress

Environment:
  STRESS_API_KEY, STRESS_PROJECT, STRESS_BASE, STRESS_MANIFEST

Paths measured:
  feed                  home feed: newest public posts
  feed-following        posts by 30 followed authors (IN query)
  trending              posts ordered by likeCount
  post                  get one post by ID
  comments              list one post's comments
  profile               get one profile by ID
  profile-posts         list one author's posts
  search                fulltext search on post content
  create-post           PUT a new post (random ID)
  like                  PUT a new post like (random ID)
  like-count            PATCH posts/<hot>/likeCount/increment
  comment               PUT a new comment
  comment-like          PUT a new comment like
  comment-like-count    PATCH comments/<hot>/likeCount/increment
  repost                PUT a new repost
  repost-count          PATCH posts/<hot>/repostCount/increment
  follow                PUT a new follow
  follow-count          PATCH profiles/<hot>/followerCount/increment
  me                    session run: read the logged-in user's profile

The report estimates active users from ${CALLS_PER_USER_MINUTE} calls per user per 60s.
WebSocket delivery, media uploads and notifications are intentionally excluded.`)
}

try {
  if (command === 'setup') await setup()
  else if (command === 'run') await run()
  else if (command === 'mix') await runMix()
  else if (command === 'session') await runSession()
  else if (command === 'cleanup') await cleanup()
  else {
    const manifest = await setup()
    await runWith(runOptions(manifest))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

async function run(): Promise<void> {
  await runWith(runOptions())
}

async function runWith(options: RunOptions): Promise<void> {
  const { results, file } = await runMatrix({
    targets: targetsFor(options),
    headers: {
      'X-Appwrite-Project': options.api.project,
      'X-Appwrite-Key': options.api.key,
    },
    concurrency: options.concurrency,
    duration: options.duration,
    warmup: options.warmup,
    timeout: options.timeout,
    tool: options.tool,
    outDir: options.out,
    meta: {
      kind: 'social',
      startedAt: new Date().toISOString(),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      base: options.api.base,
      project: options.api.project,
      database: options.manifest.database,
      prefix: options.manifest.prefix,
      concurrency: options.concurrency,
      writeConcurrency: options.writeConcurrency,
      durationSec: options.duration,
      paths: options.paths,
      callsPerUserMinute: CALLS_PER_USER_MINUTE,
    },
    log: (line) => console.log(line),
  })
  const report = markdownReport(options, results, file)
  const reportPath = file.replace(/\.json$/, '.md')
  writeFileSync(reportPath, report)
  console.log(`\n${report}`)
  console.log(`report: ${reportPath}`)
}
