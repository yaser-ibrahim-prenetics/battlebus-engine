import { NextResponse } from "next/server";
import { IResponse } from "../types";

export const successResponse = <T>(message: string, data: T): NextResponse<IResponse<T>> => {
  return NextResponse.json(
    {
      success: true,
      message,
      data,
    },
    { status: 200 }
  );
};

export const errorResponse = (
  error: string,
  status: number = 400
): NextResponse<IResponse<null>> => {
  console.error(`[GPS Individual] ${error}`);
  return NextResponse.json(
    {
      success: false,
      message: "Internal server error",
      error,
    },
    { status }
  );
};
