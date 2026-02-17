import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { GARMENT_TYPES, GARMENT_CATEGORIES } from "@/lib/constants";

type GarmentType = (typeof GARMENT_TYPES)[number];
type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

export interface GarmentInfo {
  garmentType: GarmentType;
  garmentCategory: GarmentCategory;
  brand: string;
  title: string;
  description: string;
}

const CATEGORY_BY_TYPE: Record<GarmentType, GarmentCategory[]> = {
  tops: ["t-shirt", "shirt", "blouse", "sweater", "hoodie"],
  bottoms: ["jeans", "pants", "shorts", "skirt"],
  outerwear: ["jacket", "coat"],
  dresses: ["dress"],
  footwear: ["sneakers", "boots", "sandals"],
  accessories: ["hat", "bag", "belt", "scarf", "other"],
};

function formatLabel(value: string): string {
  return value
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface FormErrors {
  garmentType?: string;
  garmentCategory?: string;
  title?: string;
}

interface GarmentInfoFormProps {
  onSubmit: (info: GarmentInfo) => void;
  defaultValues?: Partial<GarmentInfo>;
}

export function GarmentInfoForm({
  onSubmit,
  defaultValues,
}: GarmentInfoFormProps) {
  const [garmentType, setGarmentType] = useState<string>(
    defaultValues?.garmentType ?? ""
  );
  const [garmentCategory, setGarmentCategory] = useState<string>(
    defaultValues?.garmentCategory ?? ""
  );
  const [brand, setBrand] = useState(defaultValues?.brand ?? "");
  const [title, setTitle] = useState(defaultValues?.title ?? "");
  const [description, setDescription] = useState(
    defaultValues?.description ?? ""
  );
  const [errors, setErrors] = useState<FormErrors>({});

  const availableCategories =
    garmentType && garmentType in CATEGORY_BY_TYPE
      ? CATEGORY_BY_TYPE[garmentType as GarmentType]
      : [...GARMENT_CATEGORIES];

  function handleTypeChange(value: string) {
    setGarmentType(value);
    // Reset category if it's no longer valid for the new type
    if (
      garmentCategory &&
      value in CATEGORY_BY_TYPE &&
      !CATEGORY_BY_TYPE[value as GarmentType].includes(
        garmentCategory as GarmentCategory
      )
    ) {
      setGarmentCategory("");
    }
    setErrors((prev) => ({ ...prev, garmentType: undefined }));
  }

  function handleCategoryChange(value: string) {
    setGarmentCategory(value);
    setErrors((prev) => ({ ...prev, garmentCategory: undefined }));
  }

  function validate(): FormErrors {
    const newErrors: FormErrors = {};
    if (!garmentType) {
      newErrors.garmentType = "Garment type is required";
    }
    if (!garmentCategory) {
      newErrors.garmentCategory = "Garment category is required";
    }
    if (!title.trim()) {
      newErrors.title = "Title is required";
    } else if (title.trim().length > 100) {
      newErrors.title = "Title must be 100 characters or less";
    }
    return newErrors;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const newErrors = validate();
    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) return;

    onSubmit({
      garmentType: garmentType as GarmentType,
      garmentCategory: garmentCategory as GarmentCategory,
      brand: brand.trim(),
      title: title.trim(),
      description: description.trim(),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="garment-type">
          Garment Type <span className="text-destructive">*</span>
        </Label>
        <Select value={garmentType} onValueChange={handleTypeChange}>
          <SelectTrigger
            id="garment-type"
            className="w-full"
            aria-invalid={!!errors.garmentType}
          >
            <SelectValue placeholder="Select garment type" />
          </SelectTrigger>
          <SelectContent>
            {GARMENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {formatLabel(type)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.garmentType && (
          <p className="text-sm text-destructive">{errors.garmentType}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="garment-category">
          Category <span className="text-destructive">*</span>
        </Label>
        <Select value={garmentCategory} onValueChange={handleCategoryChange}>
          <SelectTrigger
            id="garment-category"
            className="w-full"
            aria-invalid={!!errors.garmentCategory}
          >
            <SelectValue placeholder="Select category" />
          </SelectTrigger>
          <SelectContent>
            {availableCategories.map((category) => (
              <SelectItem key={category} value={category}>
                {formatLabel(category)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.garmentCategory && (
          <p className="text-sm text-destructive">{errors.garmentCategory}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="brand">Brand</Label>
        <Input
          id="brand"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="e.g. Nike, Levi's, Zara"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="title">
          Title <span className="text-destructive">*</span>
        </Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (errors.title) {
              setErrors((prev) => ({ ...prev, title: undefined }));
            }
          }}
          placeholder="e.g. Vintage Levi's 501 Jeans"
          maxLength={100}
          aria-invalid={!!errors.title}
        />
        <div className="flex items-center justify-between">
          {errors.title ? (
            <p className="text-sm text-destructive">{errors.title}</p>
          ) : (
            <span />
          )}
          <p className="text-xs text-muted-foreground">
            {title.length}/100
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 500))}
          placeholder="Describe the garment's condition, notable features, or any defects..."
          rows={4}
        />
        <p className="text-xs text-muted-foreground text-right">
          {description.length}/500
        </p>
      </div>

      <Button type="submit" className="w-full">
        Continue
      </Button>
    </form>
  );
}
