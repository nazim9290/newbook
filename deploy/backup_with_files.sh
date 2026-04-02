#!/bin/bash
# AgencyBook Backup Script — DB + Files
# Run daily at 2:00 AM via cron: 0 2 * * * /home/agencybook/backup_with_files.sh
#
# সেটআপ:
#   1. এই ফাইল VPS-এ /home/agencybook/backup_with_files.sh তে কপি করুন
#   2. chmod +x /home/agencybook/backup_with_files.sh
#   3. crontab -e → 0 2 * * * /home/agencybook/backup_with_files.sh >> /home/agencybook/backups/backup.log 2>&1
#   4. DB_PASS environment variable সেট করুন (.bashrc বা crontab-এ)

BACKUP_DIR="/home/agencybook/backups"
DATE=$(date +%Y-%m-%d_%H%M)
DB_NAME="agencybook_db"
DB_USER="agencybook"

# ব্যাকআপ ফোল্ডার তৈরি (না থাকলে)
mkdir -p "$BACKUP_DIR"

# 1. Database backup — pg_dump + gzip compression
echo "[Backup] Starting DB backup — $DATE"
PGPASSWORD="${DB_PASS}" pg_dump -U $DB_USER -h 127.0.0.1 $DB_NAME | gzip > "$BACKUP_DIR/db_${DATE}.sql.gz"

# 2. Files backup — uploads directory (avatars, logos, documents)
echo "[Backup] Starting files backup — $DATE"
tar -czf "$BACKUP_DIR/files_${DATE}.tar.gz" -C /home/agencybook uploads/

# 3. Cleanup — 7 দিনের পুরানো ব্যাকআপ ডিলিট
find "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete

echo "[Backup] Complete — $DATE"
echo "  DB: $BACKUP_DIR/db_${DATE}.sql.gz"
echo "  Files: $BACKUP_DIR/files_${DATE}.tar.gz"
