export type OpenAiAdsTransportConfiguration = {
  endpoint: string;
  apiVersion: string;
  sourceUrl: string;
};

export type OpenAiAdsConfigurationProblem = {
  code: "endpoint_invalid" | "api_version_invalid" | "source_url_invalid";
  message: string;
};

export function openAiAdsConfigurationProblems(
  settings: OpenAiAdsTransportConfiguration
): OpenAiAdsConfigurationProblem[] {
  const problems: OpenAiAdsConfigurationProblem[] = [];
  try {
    const endpoint = new URL(settings.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "bzr.openai.com" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "")
    ) {
      problems.push({
        code: "endpoint_invalid",
        message: "OPENAI_ADS_ENDPOINT must be the HTTPS bzr.openai.com origin",
      });
    }
  } catch {
    problems.push({
      code: "endpoint_invalid",
      message: "OPENAI_ADS_ENDPOINT must be a valid HTTPS URL",
    });
  }

  if (!/^v[1-9][0-9]*$/.test(settings.apiVersion)) {
    problems.push({
      code: "api_version_invalid",
      message: "OPENAI_ADS_API_VERSION must look like v1",
    });
  }

  if (settings.sourceUrl) {
    try {
      if (new URL(settings.sourceUrl).protocol !== "https:") {
        problems.push({
          code: "source_url_invalid",
          message: "OPENAI_ADS_SOURCE_URL must use HTTPS",
        });
      }
    } catch {
      problems.push({
        code: "source_url_invalid",
        message: "OPENAI_ADS_SOURCE_URL must be a valid HTTPS URL",
      });
    }
  }

  return problems;
}

export function buildOpenAiAdsEventsUrl(
  settings: Pick<OpenAiAdsTransportConfiguration, "endpoint" | "apiVersion">,
  pixelId: string
): URL {
  const endpoint = new URL(settings.endpoint);
  endpoint.pathname = `/${settings.apiVersion}/events`;
  endpoint.searchParams.set("pid", pixelId);
  return endpoint;
}
