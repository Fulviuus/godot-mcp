class_name Player
extends CharacterBody2D
## A small player controller used to exercise the GDScript outline parser.

signal health_changed(old_value: int, new_value: int)
signal died

const MAX_HEALTH := 100
const GRAVITY := 980.0

enum State { IDLE, RUNNING, JUMPING }

@export var speed: float = 220.0
@export var jump_velocity: float = -400.0
@export_range(0, 100) var starting_health: int = 100

var _health: int = MAX_HEALTH
var _state: State = State.IDLE


func _ready() -> void:
	_health = starting_health


func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += GRAVITY * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_velocity
		_state = State.JUMPING
	var direction := Input.get_axis("ui_left", "ui_right")
	velocity.x = direction * speed
	move_and_slide()


func take_damage(amount: int) -> void:
	var old := _health
	_health = max(0, _health - amount)
	health_changed.emit(old, _health)
	if _health == 0:
		died.emit()


static func describe() -> String:
	return "Player controller"
