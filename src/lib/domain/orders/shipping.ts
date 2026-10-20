/** Business policy; carrier credentials and warehouse configuration are adapter concerns. */
export function selectShippingChannel(input: {
  tags?: string | null;
  isUkWarehouse: boolean;
  standardChannel: string;
  expeditedChannel: string;
}): string {
  const expedited = (input.tags ?? "")
    .split(",")
    .some((tag) => tag.trim().toLowerCase() === "expedited shipping");
  return input.isUkWarehouse && expedited ? input.expeditedChannel : input.standardChannel;
}
