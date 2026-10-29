/** Keep the Saudi short code exactly once, at the end of GPS Address2.
 * Only remove a known code, or a single unambiguous code already in the address.
 */
export function toSaudiGpsAddressLines(
  address1: string,
  address2: string,
  shortAddress?: string
): { addressOne: string; addressTwo: string } {
  const suppliedCode = shortAddress?.trim().toUpperCase() ?? "";
  const embeddedCodes = Array.from(
    new Set(
      (`${address1} ${address2}`.match(/\b[A-Z]{4}\d{4}\b/gi) ?? []).map((code) =>
        code.toUpperCase()
      )
    )
  );
  const code = /^[A-Z]{4}\d{4}$/.test(suppliedCode)
    ? suppliedCode
    : !suppliedCode && embeddedCodes.length === 1
      ? embeddedCodes[0]
      : undefined;
  if (!code) {
    return { addressOne: address1, addressTwo: address2 };
  }
  const removeCode = (line: string): string => {
    const pattern = new RegExp(`\\b${code}\\b`, "gi");
    if (!pattern.test(line)) return line;
    return line
      .replace(pattern, "")
      .replace(/,\s*,/g, ",")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,]+|[\s,]+$/g, "");
  };
  const secondLine = removeCode(address2).replace(/^[\s,]+|[\s,]+$/g, "");
  return {
    addressOne: removeCode(address1),
    addressTwo: secondLine ? `${secondLine} ${code}` : code,
  };
}
