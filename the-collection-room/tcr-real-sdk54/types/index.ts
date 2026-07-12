export type Folder = {
  id: string;
  user_id: string;
  name: string;
  cover_image_url: string | null;
  cover_source: string; // 'upload' | 'first_card'
  is_public: boolean;
  created_at: string;
};

export type CollectionItem = {
  id: string;
  folder_id: string;
  user_id: string;
  title: string | null;
  year: number | null;
  brand: string | null;
  player: string | null;
  team: string | null;
  grade: string | null;
  grading_company: string | null;
  serial_number: string | null;
  estimated_value: number | null;
  image_url: string | null;
  description: string | null;
  created_at: string;
};

export type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  hero_display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  hero_image_url: string | null;
  hero_theme: string | null;
  showcase_badge_url: string | null;
  created_at: string;
};

export type Post = {
  id: string;
  user_id: string;
  post_type: 'item' | 'text' | 'rate_my_grails';
  item_id: string | null;
  image_url: string | null;
  content: string | null;
  caption: string | null;
  created_at: string;
};

export type ShowcaseItem = {
  id: string;
  user_id: string;
  item_id: string;
  display_order: number;
  note: string | null;
  badge_type: string | null;
  added_at: string;
  item: CollectionItem;
};

// Snapshot of one grail at the moment a Rate My Grails post was created —
// deliberately denormalized (snapshot_*) so the post keeps rendering even if
// the source collection_item is later edited or deleted. item_id is only an
// optional "view original card" link, never required for rendering.
export type RateMyGrailCard = {
  id: string;
  post_id: string;
  item_id: string | null;
  snapshot_image_url: string;
  snapshot_title: string | null;
  snapshot_subtitle: string | null;
  display_order: number;
};

export type GrailRating = {
  post_id: string;
  rater_user_id: string;
  score: number;
  updated_at: string;
};
