-- migration: doc_types টেবিলে student_fillable কলাম যোগ
-- student_fillable = true হলে Student Portal থেকে student নিজে পূরণ করতে পারবে

ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS student_fillable BOOLEAN DEFAULT false;
COMMENT ON COLUMN doc_types.student_fillable IS 'Student portal থেকে student নিজে পূরণ করতে পারবে কিনা';
