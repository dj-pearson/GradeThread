import { describe, it, expect } from "vitest";
import { detectDelimiter, parseDelimited, parseSheet } from "@/lib/csv";

describe("parseDelimited", () => {
  it("treats an inch mark mid-field as a literal quote", () => {
    const rows = parseDelimited('Title,Size,Price\nLevi 501 32" waist,M,20\nNike Tee,L,15\n', ",");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.length === 3)).toBe(true);
    expect(rows[1]?.[0]).toBe('Levi 501 32" waist');
    expect(rows[2]).toEqual(["Nike Tee", "L", "15"]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    expect(parseDelimited('"He said ""hi""",2', ",")).toEqual([['He said "hi"', "2"]]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseDelimited('"a\nb",c\nd,e', ",")).toEqual([["a\nb", "c"], ["d", "e"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseDelimited("a,b\r\nc,d\r\n", ",")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("treats a lone CR as a row break", () => {
    expect(parseDelimited("a,b\rc,d", ",")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("strips a leading BOM so the first header reads cleanly", () => {
    const { headers } = parseSheet("\uFEFFTitle,Price\nTee,5");
    expect(headers[0]).toBe("Title");
  });

  it("drops interior blank rows", () => {
    const { rows } = parseSheet("Name,N\nA,1\n\nB,2");
    expect(rows).toEqual([["A", "1"], ["B", "2"]]);
  });

  it("keeps a quoted empty field", () => {
    expect(parseDelimited('"",x', ",")).toEqual([["", "x"]]);
  });
});

describe("detectDelimiter", () => {
  it("detects a semicolon file", () => {
    const text = "Title;Size;Price\nLevi, 501;M;20,50\nTee;L;15";
    expect(detectDelimiter(text)).toBe(";");
    const { headers, rows } = parseSheet(text);
    expect(headers).toHaveLength(3);
    expect(rows[0]).toEqual(["Levi, 501", "M", "20,50"]);
  });

  it("detects tabs and pipes", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("defaults to comma for a single column", () => {
    expect(detectDelimiter("Title\nTee")).toBe(",");
  });
});
