# 0.2.38 deployed source recovery

Recovered the previously deployed but uncommitted source on 2026-10-20 from the release patch based on d41eb654ad455d2b70c583f9a92b62d31eef8ca1. The release patch SHA-256 is 09071b5d5725e8657b55e23c98f6910c902bb7c72fc30a88ca5df2fe0abaa618; package SHA-256 is 6c304ae971f06d860a55f6d66fcdf7fb534594e61e9b69cc914a095aca71a7b5.

`npm run build -w @dsh-task/task-system` passed. All 310 files rebuilt from this recovered source match the published 0.2.38 tarball byte for byte. This commit records the existing deployed baseline; new task delivery and workspace changes follow separately.
