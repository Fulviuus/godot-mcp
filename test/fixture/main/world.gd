extends Node2D
## Root world script for the fixture main scene.

@onready var player: Player = $Player


func _ready() -> void:
	if player:
		player.health_changed.connect(_on_player_health_changed)


func _on_player_died() -> void:
	get_tree().reload_current_scene()


func _on_player_health_changed(_old: int, new_value: int) -> void:
	GameState.last_health = new_value
