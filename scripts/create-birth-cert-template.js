const { Document, Packer, Paragraph, TextRun, AlignmentType } = require("docx");
const fs = require("fs");

const doc = new Document({
  sections: [{
    properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } },
    children: [
      // Header
      p(AlignmentType.CENTER, [bold("TRANSLATION", 28)], 100),
      p(AlignmentType.CENTER, [italic("(From Bangla to English)", 20)], 50),
      p(AlignmentType.CENTER, [text("_______________________________________________", 18, "999999")], 200),

      // Title
      p(AlignmentType.CENTER, [bold("People's Republic of Bangladesh", 24)], 100),
      p(AlignmentType.CENTER, [text("Office of Birth and Death Registration", 20)], 50),
      p(AlignmentType.CENTER, [text("{{UnionName}} Union Parishad", 20)], 50),
      p(AlignmentType.CENTER, [text("{{Upazila}}, {{District}}", 20)], 50),
      p(AlignmentType.CENTER, [new TextRun({ text: "BIRTH CERTIFICATE", bold: true, size: 28, font: "Times New Roman", underline: {} })], 200),

      // Rule
      p(null, [italic("[Rule-9, Birth and Death Registration (Union Parishad) Rules, 2006]", 18)], 50),
      p(null, [italic("(Issued from Birth Registration Book)", 18)], 200),

      // Registration
      row("Registration Book No", "{{RegistrationBookNo}}"),
      p(null, [
        bold("Registration Date: ", 22), text("{{RegistrationDate}}", 22),
        bold("          Certificate Issue Date: ", 22), text("{{IssueDate}}", 22),
      ], 100),
      row("Birth Registration No", "{{BirthRegNo}}"),
      spacer(),

      // Personal
      row("Name", "{{Name}}"),
      p(null, [
        bold("Date of Birth: ", 22), text("{{DOB}}", 22),
        bold("                    Gender: ", 22), text("{{Gender}}", 22),
      ], 100),
      row("Date of Birth (in words)", "{{DOBInWords}}"),
      row("Place of Birth", "{{BirthPlace}}"),
      spacer(),

      // Parents
      p(null, [
        bold("Father's Name: ", 22), text("{{FatherName}}", 22),
        bold("          Nationality: ", 22), text("{{FatherNationality}}", 22),
      ], 100),
      p(null, [
        bold("Mother's Name: ", 22), text("{{MotherName}}", 22),
        bold("          Nationality: ", 22), text("{{MotherNationality}}", 22),
      ], 200),

      // Address
      p(null, [bold("Permanent Address:", 22)], 50),
      p(null, [text("Village: {{Village}},  Union: {{UnionName}},  Upazila: {{Upazila}},  District: {{District}}", 22)], 200),

      // Footer line
      p(null, [text("_______________________________________________", 18, "999999")], 50),
      p(null, [italic("This is a certified translation of the original Birth Certificate issued by the Government of Bangladesh.", 18)], 50),
      p(null, [italic("The translation is true and accurate to the best of my knowledge.", 18)], 200),

      // Translator info
      p(null, [bold("Translated by: ", 20), text("{{TranslatorName}}", 20)], 50),
      p(null, [bold("Date of Translation: ", 20), text("{{TranslationDate}}", 20)], 50),
      p(null, [bold("Agency: ", 20), text("{{AgencyName}}", 20)], 50),
    ],
  }],
});

// Helper functions
function p(align, children, after = 100) {
  return new Paragraph({ alignment: align || AlignmentType.LEFT, spacing: { after }, children });
}
function bold(t, size) { return new TextRun({ text: t, bold: true, size, font: "Times New Roman" }); }
function text(t, size, color) { return new TextRun({ text: t, size, font: "Times New Roman", ...(color ? { color } : {}) }); }
function italic(t, size) { return new TextRun({ text: t, size, font: "Times New Roman", italics: true }); }
function row(label, value) {
  return p(null, [bold(label + ": ", 22), text(value, 22)], 100);
}
function spacer() { return new Paragraph({ spacing: { after: 100 }, children: [] }); }

// Save
Packer.toBuffer(doc).then(buffer => {
  const outPath = "c:/Users/User/Desktop/Birth_Certificate_Translation_Template.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Template saved:", outPath);
  console.log("Size:", (buffer.length / 1024).toFixed(1), "KB");
});
