// Supabase Edge Function: generate-excel
// Takes a template mapping + student IDs, returns filled CSV
// POST /functions/v1/generate-excel { template_id, student_ids }

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

    const { template_id, student_ids, mappings: directMappings } = await req.json();

    // Get mappings from template or direct input
    let mappings = directMappings;
    let schoolName = "Export";

    if (template_id) {
      const { data: template, error } = await supabase
        .from("excel_templates")
        .select("*")
        .eq("id", template_id)
        .single();
      if (error) throw error;
      mappings = template.mappings;
      schoolName = template.school_name;
    }

    if (!mappings || !Array.isArray(mappings) || mappings.length === 0) {
      return new Response(JSON.stringify({ error: "No mappings provided" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!student_ids || !Array.isArray(student_ids) || student_ids.length === 0) {
      return new Response(JSON.stringify({ error: "No student_ids provided" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch students with related data
    const { data: students, error: sErr } = await supabase
      .from("students")
      .select(`
        *,
        student_education(*),
        student_jp_exams(*),
        student_family(*),
        sponsors(*)
      `)
      .in("id", student_ids);

    if (sErr) throw sErr;

    // Flatten student data for mapping
    const flattenStudent = (s: any) => {
      const flat: Record<string, string> = { ...s };
      // Add sponsor fields
      if (s.sponsors?.[0]) {
        const sp = s.sponsors[0];
        Object.entries(sp).forEach(([k, v]) => { flat[`sponsor_${k}`] = String(v ?? ""); });
      }
      // Add latest JP exam
      if (s.student_jp_exams?.length > 0) {
        const latest = s.student_jp_exams.sort((a: any, b: any) =>
          (b.exam_date || "").localeCompare(a.exam_date || "")
        )[0];
        flat.jp_exam_type = latest.exam_type;
        flat.jp_level = latest.level;
        flat.jp_score = String(latest.score ?? "");
        flat.jp_result = latest.result;
      }
      // Education levels
      if (s.student_education) {
        for (const edu of s.student_education) {
          const prefix = (edu.level || "").toLowerCase().replace(/[^a-z]/g, "_");
          flat[`edu_${prefix}_year`] = edu.year || "";
          flat[`edu_${prefix}_gpa`] = edu.gpa || "";
          flat[`edu_${prefix}_board`] = edu.board || "";
        }
      }
      return flat;
    };

    // Generate CSV
    const headers = mappings.map((m: any) => m.label);
    const BOM = "\uFEFF"; // For Bengali/Japanese in Excel

    const rows = (students || []).map((s: any) => {
      const flat = flattenStudent(s);
      return mappings.map((m: any) => {
        const val = String(flat[m.field] ?? "").replace(/"/g, '""');
        return val.includes(",") || val.includes("\n") || val.includes('"') ? `"${val}"` : val;
      }).join(",");
    });

    const csv = BOM + headers.join(",") + "\n" + rows.join("\n");

    return new Response(csv, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${schoolName}_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
