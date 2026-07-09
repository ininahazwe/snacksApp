-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.products (
                                 id uuid NOT NULL DEFAULT gen_random_uuid(),
                                 name text NOT NULL,
                                 price numeric NOT NULL,
                                 stock integer NOT NULL DEFAULT 0,
                                 barcode text UNIQUE,
                                 emoji text DEFAULT '🍬'::text,
                                 color text DEFAULT '#F5C842'::text,
                                 created_at timestamp with time zone DEFAULT now(),
                                 cost numeric DEFAULT 0,
                                 category text DEFAULT 'Autre'::text,
                                 CONSTRAINT products_pkey PRIMARY KEY (id)
);
CREATE TABLE public.clients (
                                id uuid NOT NULL DEFAULT gen_random_uuid(),
                                name text NOT NULL,
                                phone text,
                                debt numeric NOT NULL DEFAULT 0,
                                created_at timestamp with time zone DEFAULT now(),
                                credit numeric NOT NULL DEFAULT 0,
                                CONSTRAINT clients_pkey PRIMARY KEY (id)
);
CREATE TABLE public.sales (
                              id uuid NOT NULL DEFAULT gen_random_uuid(),
                              product_id uuid,
                              client_id uuid,
                              qty integer NOT NULL DEFAULT 1,
                              amount numeric NOT NULL,
                              type text NOT NULL CHECK (type = ANY (ARRAY['cash'::text, 'dette'::text, 'paiement'::text])),
                              created_at timestamp with time zone DEFAULT now(),
                              user_id uuid,
                              CONSTRAINT sales_pkey PRIMARY KEY (id),
                              CONSTRAINT sales_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id),
                              CONSTRAINT sales_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id),
                              CONSTRAINT sales_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.stock_movements (
                                        id uuid NOT NULL DEFAULT gen_random_uuid(),
                                        product_id uuid,
                                        delta integer NOT NULL,
                                        reason text,
                                        created_at timestamp with time zone DEFAULT now(),
                                        batch_id uuid,
                                        CONSTRAINT stock_movements_pkey PRIMARY KEY (id),
                                        CONSTRAINT stock_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id),
                                        CONSTRAINT stock_movements_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id)
);
CREATE TABLE public.stock_batches (
                                      id uuid NOT NULL DEFAULT gen_random_uuid(),
                                      product_id uuid NOT NULL,
                                      received_qty integer NOT NULL,
                                      received_at timestamp with time zone DEFAULT now(),
                                      exhausted_at timestamp with time zone,
                                      duration_days integer,
                                      created_at timestamp with time zone DEFAULT now(),
                                      CONSTRAINT stock_batches_pkey PRIMARY KEY (id),
                                      CONSTRAINT stock_batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id)
);