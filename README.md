# Global Climate & Sustainability B2B Leads Finder

This Apify Actor is designed to crawl seed URLs (company domains, directories, etc.) and enrich them into B2B leads by detecting strong sustainability and ESG (Environmental, Social, and Governance) signals. 

It is designed for ESG consultants, climate-tech SaaS providers, impact investors, and procurement teams looking to identify and qualify companies based on their public climate commitments.

## Features

- **Deep Domain Crawling**: Crawls up to a configurable depth from seed domains.
- **Sustainability Signal Detection**: Identifies dedicated sustainability pages, ESG reports, and explicit climate commitments (e.g., "Net Zero", "SBTi", "Decarbonization").
- **PDF Report Discovery**: Finds and categorizes sustainability and annual ESG reports.
- **ESG Job Detection**: Identifies companies actively hiring for ESG/Sustainability roles (optional).
- **Automated Scoring**: Assigns a `sustainabilityIntentScore` (0–100) based on the strength and variety of detected signals.
- **Compliance**: Only relies on publicly available corporate information.

## Typical Use Cases

1. **Lead Generation**: Input a list of 1,000 general B2B domains, output the 150 that have active sustainability programs or released ESG reports.
2. **Impact Investing**: Scan portfolios or directories of companies to score their climate commitments (Net Zero targets, ISO 14001, GRI reporting).
3. **Supplier Risk & Procurement**: Automatically verify if vendors have public sustainability policies or reports.

## Input Configuration

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `seeds` | Array | (Required) | List of starting URLs (e.g., `["https://example.com"]`) |
| `maxDepth` | Integer | 2 | Maximum crawl depth from each seed |
| `maxCompanies` | Integer | 1000 | Hard limit on the number of company records to output |
| `includeJobPages` | Boolean | true | Whether to search for ESG-related jobs on careers pages |
| `includeReports` | Boolean | true | Whether to look for ESG/sustainability report PDFs |
| `minScore` | Number | 0 | Minimum intent score (0-100) to include in the output |

## Output Example

The actor produces structured datasets. Here is an example of an output record for a single company:

```json
{
  "companyName": "Acme Widgets",
  "domain": "acmewidgets.com",
  "rootUrl": "https://www.acmewidgets.com",
  "hqCountryGuess": "USA",
  "sustainabilityPages": [
    {
      "url": "https://www.acmewidgets.com/about/sustainability",
      "title": "Sustainability - Acme"
    }
  ],
  "reports": [
    {
      "url": "https://www.acmewidgets.com/files/Impact-Report-2023.pdf",
      "title": "2023 Impact Report",
      "yearGuess": 2023,
      "type": "Sustainability Report"
    }
  ],
  "certifications": ["ISO 14001", "SBTi"],
  "netZeroCommitment": {
    "hasCommitment": true,
    "targetYear": 2040,
    "sourceUrl": "https://www.acmewidgets.com/about/sustainability"
  },
  "esgJobs": [
    {
      "title": "Director of Sustainability",
      "location": null,
      "url": "https://careers.acmewidgets.com/job/123",
      "sourceDomain": "acmewidgets.com"
    }
  ],
  "contact": {
    "emails": [],
    "contactPageUrls": []
  },
  "social": {
    "linkedin": null,
    "twitter": null,
    "facebook": null
  },
  "sustainabilityIntentScore": 85,
  "firstSeenAt": "2024-05-15T12:00:00.000Z",
  "lastUpdatedAt": "2024-05-15T12:05:00.000Z"
}
```

## Privacy and Compliance
This actor is a web scraper that extracts non-personal, publicly available B2B information. It is intended for B2B lead generation. Always ensure your use of this data complies with applicable regulations (e.g., GDPR, CCPA) regarding B2B communications.
