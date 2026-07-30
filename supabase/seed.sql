-- =============================================================================
-- Corya — Seed de développement
-- Cabinets 100% fictifs. Aucun vrai nom, aucun vrai numéro, aucun vrai email.
-- Les numéros +41 21 555 xx xx sont dans la plage "555" réservée aux fictions.
-- =============================================================================

INSERT INTO public.cabinets (
  nom, slug, type_cabinet, adresse, npa, ville, canton,
  numero_principal, numero_corya, email_notification
) VALUES
  (
    'Cabinet de Physiothérapie du Léman',
    'physio-leman-demo',
    'physio',
    'Rue de la Demo 1',
    '1004',
    'Lausanne',
    'VD',
    '+41215550101',
    '+41215559001',
    'demo-physio@example.com'
  ),
  (
    'Cabinet Généraliste des Collines',
    'generaliste-collines-demo',
    'generaliste',
    'Chemin des Tests 42',
    '1201',
    'Genève',
    'GE',
    '+41225550202',
    '+41215559002',
    'demo-generaliste@example.com'
  ),
  (
    'Ostéopathie du Jura',
    'osteo-jura-demo',
    'osteo',
    'Route Fictive 7',
    '2000',
    'Neuchâtel',
    'NE',
    '+41325550303',
    '+41215559003',
    'demo-osteo@example.com'
  )
ON CONFLICT (slug) DO NOTHING;

-- Un admin de dev (email fictif à remplacer par ton email pro pour tester
-- l'auth magic link en local).
INSERT INTO public.admin_users (email, nom, role)
VALUES ('dev-admin@example.com', 'Dev Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
