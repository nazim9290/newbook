// Supabase Edge Function: cross-validate
// Compares extracted fields across all documents of a student
// POST /functions/v1/cross-validate { student_id }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { student_id } = await req.json();
    if (!student_id) {
      return new Response(JSON.stringify({ error: "student_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get all documents with their fields
    const { data: docs, error } = await supabase
      .from("documents")
      .select("id, doc_type, label, document_fields(field_name, field_value)")
      .eq("student_id", student_id);

    if (error) throw error;

    // Fields to compare across documents
    const COMPARE_FIELDS = [
      "name_en", "father_en", "mother_en", "dob",
      "permanent_address", "nid", "passport_number",
    ];

    // Build field map: { field_name: [{ doc_type, doc_id, value }] }
    const fieldMap: Record<string, { doc_type: string; doc_id: string; value: string }[]> = {};
    for (const doc of docs || []) {
      for (const f of doc.document_fields || []) {
        if (!COMPARE_FIELDS.includes(f.field_name)) continue;
        if (!f.field_value) continue;
        if (!fieldMap[f.field_name]) fieldMap[f.field_name] = [];
        fieldMap[f.field_name].push({
          doc_type: doc.doc_type,
          doc_id: doc.id,
          value: f.field_value.trim().toLowerCase(),
        });
      }
    }

    // Find mismatches
    const mismatches = [];
    for (const [field, entries] of Object.entries(fieldMap)) {
      if (entries.length < 2) continue;
      const uniqueValues = [...new Set(entries.map((e) => e.value))];
      if (uniqueValues.length > 1) {
        mismatches.push({
          field,
          severity: ["name_en", "dob", "passport_number"].includes(field) ? "error" : "warning",
          docs: entries.map((e) => e.doc_type),
          values: entries.map((e) => e.value),
          entries,
        });
      }
    }

    return new Response(
      JSON.stringify({
        student_id,
        total_docs: (docs || []).length,
        fields_compared: Object.keys(fieldMap).length,
        mismatches,
        validated_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
