resource "google_dns_record_set" "apex_a" {
  count = var.create_dns_records ? 1 : 0

  project      = var.project_id
  managed_zone = var.dns_zone_name
  name         = "${var.domain_name}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.nova_ip.address]
}

resource "google_dns_record_set" "www_a" {
  count = var.create_dns_records ? 1 : 0

  project      = var.project_id
  managed_zone = var.dns_zone_name
  name         = "www.${var.domain_name}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.nova_ip.address]
}
