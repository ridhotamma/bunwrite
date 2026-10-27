-- Views that expose users, teams and memberships with the column names the
-- document query compiler expects, so Appwrite queries work on them unchanged.
CREATE VIEW `v_users` AS SELECT
  seq AS _seq, id AS _id, created_at AS _createdAt, updated_at AS _updatedAt, '[]' AS _permissions,
  name, email, phone, status, labels, registration,
  password_update AS passwordUpdate, email_verification AS emailVerification,
  phone_verification AS phoneVerification, accessed_at AS accessedAt
FROM _users;
--> statement-breakpoint
CREATE VIEW `v_teams` AS SELECT
  t.seq AS _seq, t.id AS _id, t.created_at AS _createdAt, t.updated_at AS _updatedAt, '[]' AS _permissions,
  t.name AS name,
  (SELECT count(*) FROM _memberships m WHERE m.team_id = t.id AND m.confirm = 1) AS total
FROM _teams t;
--> statement-breakpoint
CREATE VIEW `v_memberships` AS SELECT
  m.seq AS _seq, m.id AS _id, m.created_at AS _createdAt, m.updated_at AS _updatedAt, '[]' AS _permissions,
  m.user_id AS userId, m.team_id AS teamId, m.invited AS invited, m.joined AS joined,
  m.confirm AS confirm, m.roles AS roles,
  u.name AS userName, u.email AS userEmail, t.name AS teamName
FROM _memberships m
JOIN _users u ON u.id = m.user_id
JOIN _teams t ON t.id = m.team_id;
