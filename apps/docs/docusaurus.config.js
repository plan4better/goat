// @ts-nocheck
// Note: type annotations allow type checking and IDEs autocompletion

const { themes: prismThemes } = require("prism-react-renderer");
const { sidebarItemsGenerator } = require("./src/sidebar/sections");
const { lastUpdatedVcs } = require("./src/vcs/lastUpdated");

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "GOAT Docs",
  tagline: "Guides and reference for GOAT, the open-source WebGIS for integrated planning",
  favicon: "img/favicon.ico",
  url: "https://goat.plan4better.de",
  baseUrl: "/docs/",
  organizationName: "plan4better",
  projectName: "goat",
  trailingSlash: false,
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  future: {
    experimental_vcs: lastUpdatedVcs(),
  },
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "de"],
    path: "i18n",
    localeConfigs: {
      en: {
        label: "English",
      },
      de: {
        label: "Deutsch",
      },
    },
  },
  clientModules: [require.resolve("./src/matomo.js")],
  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: "/",
          sidebarPath: require.resolve("./sidebars.js"),
          sidebarItemsGenerator,
          showLastUpdateTime: true,
          editUrl: ({ locale, docPath }) => {
            const translation = locale || 'en';
            if (translation !== 'en') {
              return `https://github.com/plan4better/goat/edit/main/apps/docs/i18n/${translation}/docusaurus-plugin-content-docs/current/${docPath}`;
            }
            return `https://github.com/plan4better/goat/edit/main/apps/docs/docs/${docPath}`;
          },
        },
        blog: false,
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      }),
    ],
  ],
  plugins: [
    require.resolve("./src/plugins/markdown-source.js"),
    require.resolve("./src/plugins/glossary.js"),
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "tutorials",
        path: "tutorials",
        routeBasePath: "tutorials",
        sidebarPath: require.resolve("./sidebarsTutorials.js"),
        showLastUpdateTime: true,
        editUrl: ({ locale, docPath }) => {
          const translation = locale || 'en';
          if (translation !== 'en') {
            return `https://github.com/plan4better/goat/edit/main/apps/docs/i18n/${translation}/docusaurus-plugin-content-docs-tutorials/current/${docPath}`;
          }
          return `https://github.com/plan4better/goat/edit/main/apps/docs/tutorials/${docPath}`;
        },
      },
    ],
    [
      "@docusaurus/plugin-client-redirects",
      {
        // Earlier addresses of the first-steps tutorial pages, and the
        // Troubleshooting page the Support page replaced.
        redirects: [
          { from: "/troubleshooting", to: "/support" },
          { from: "/tutorials/goat-first-steps", to: "/tutorials/first-steps" },
          ...[
            "start-here",
            "goat-ui",
            "exercise-introduction",
            "create-project",
            "add-data",
            "data-preparation",
            "style-layers",
            "catchment-areas",
            "create-catchment-areas",
            "share-map",
            "congratulations",
          ].map((step) => ({
            from: `/tutorials/tutorials/goat-erste-schritte/${step}`,
            to: `/tutorials/first-steps/${step}`,
          })),
        ],
        createRedirects(existingPath) {
          // Links to /2.0/<page> land on <page>.
          return existingPath.endsWith("/404.html") ? [] : [`/2.0${existingPath}`];
        },
      },
    ],
  ],

  themes: [
    [
      // Search runs in the browser on an index written at build time, one per
      // locale, so the site needs no external search service.
      "@easyops-cn/docusaurus-search-local",
      {
        language: ["en", "de"],
        // Docs and tutorials both live under the site root.
        docsRouteBasePath: "/",
        // The index hash covers these, so a docs change gives a new index URL.
        docsDir: ["docs", "tutorials", "i18n"],
        indexBlog: false,
        hashed: true,
        // The hover preview of a glossary term would show up in every snippet.
        ignoreCssSelectors: [".glossary-preview"],
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/social-card.png",
      navbar: {
        logo: {
          alt: "GOAT by Plan4Better",
          src: "img/goat-lockup.svg",
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "tutorialSidebar",
            position: "right",
            label: "Docs",
          },
          {
            to: "/tutorials",
            label: "Tutorials",
            position: "right",
            activeBaseRegex: `/tutorials/`,
          },
          {
            to: "https://plan4better.de/en/blog/",
            label: "Blog",
            position: "right",
          },
          {
            type: "localeDropdown",
            position: "right"
          },
          {
            href: "https://github.com/plan4better/goat",
            label: "GitHub",
            position: "right",
            className: "header-github-link",
            "aria-label": "GitHub",
          },
        ],
      },
      footer: {
        links: [
          {
            title: "Community",
            items: [
              {
                label: "LinkedIn",
                href: "https://www.linkedin.com/company/plan4better/",
              },
              {
                label: "GitHub",
                href: "https://github.com/plan4better",
              },
            ],
          },
          {
            title: "More",
            items: [
              {
                label: "Plan4Better",
                to: "https://plan4better.de/en/",
              },
              {
                label: "Blog",
                to: "https://plan4better.de/en/blog/",
              },
              {
                label: "References",
                href: "https://plan4better.de/en/references/",
              },
              {
                label: "Privacy",
                to: "/privacy",
              },
              {
                label: "Imprint",
                href: "https://plan4better.de/en/about-us/imprint",
              },
            ],
          },
        ],
        copyright: `Plan4Better GmbH 2026 | All Rights Reserved`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.vsDark,
      },
    }),
};

module.exports = config;
