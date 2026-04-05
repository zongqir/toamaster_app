DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum enum_value
    JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'grammar_note_type'
      AND enum_value.enumlabel = 'humorous_sentence'
  ) THEN
    ALTER TYPE public.grammar_note_type ADD VALUE 'humorous_sentence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum enum_value
    JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'grammar_note_type'
      AND enum_value.enumlabel = 'other_sentence'
  ) THEN
    ALTER TYPE public.grammar_note_type ADD VALUE 'other_sentence';
  END IF;
END $$;
