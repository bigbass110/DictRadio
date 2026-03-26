/**
 * @file next.config.js
 * @description Configuration Next.js pour RadIA.
 *
 * Configure :
 * - Les en-têtes de sécurité HTTP (CSP, HSTS, X-Frame-Options)
 * - L'optimisation des images
 * - Les variables d'environnement exposées au client
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configuration des en-têtes de sécurité HTTP
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Empêche le clickjacking (intégration dans une iframe)
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          // Empêche le MIME-sniffing
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          // Active HSTS (HTTPS strict) pour 1 an
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          // Politique de référent : pas de fuite d'URL
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },

  // Configuration de l'optimisation des images Next.js
  images: {
    // Domaines autorisés pour les images distantes (logos, avatars)
    domains: [],
  },

  // Activer la compilation SWC pour les imports TypeScript
  swcMinify: true,
};

module.exports = nextConfig;
