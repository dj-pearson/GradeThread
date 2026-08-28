-- US-2890: register the auto-upright switch in the settings registry.
--
-- One row in public.system_settings (00207 + 00208) arming the intake pass that
-- turns a sideways photo upright server-side. Read through getSetting(), so an
-- operator can switch it on for a batch and off again without a deploy.
--
-- It seeds FALSE, and that is the point of the row rather than an accident of
-- it: silently rewriting photos a seller uploaded is not something to ship on
-- by default, and US-2888 deliberately shipped the manual one-press version
-- first. This exists so the automatic one can be measured on a real batch
-- before anyone trusts it.
--
-- Nothing in the code depends on this row existing - getSetting() returns its
-- fallback for an absent key, and the fallback is false. Registering it is what
-- puts the switch in the admin settings editor, which is the difference between
-- a flag an operator can find and one they have to be told about.

insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'measure.auto_upright_enabled',
    'false'::jsonb,
    -- 'bool', not 'boolean': system_settings_value_type_check allows exactly
    -- number | bool | string | json, and 'boolean' is rejected at insert.
    'bool',
    'false'::jsonb,
    'flipdesk',
    'US-2890: when true, the intake measure pass rotates a photo whose MeasureCard is not upright, server-side, preserving the pre-rotation original so the photo editor''s Revert to original undoes it. Never applies to photos used as grading evidence. Off by default until measured on a real batch.'
  )
on conflict (key) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00682') on conflict do nothing;
