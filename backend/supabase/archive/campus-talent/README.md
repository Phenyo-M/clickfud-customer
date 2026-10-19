# Campus Talent (removed 2026-10-02)

Campus Talent was taken out of ClickFood on 2026-10-02 (`../../remove_campus_talent.sql`).
These files are kept only as a record of what it was. They are **not** part of the
database setup and must not be run unless the feature is deliberately brought back.

To bring it back, run in this order: `campus_talent.sql`, `campus_talent_storage.sql`,
`talent_username_free.sql`, `talent_views.sql`, then restore the app code from git history.
A backup of the data that existed at removal is kept outside the project.
